#!/usr/bin/env bash
# Topic 管理功能集成测试。
# 依赖：正在运行的 OpenClaw gateway + 已加载的 coclaw 插件。
# 用法：bash scripts/test-topics-integration.sh
#
# 测试矩阵：
#   1. CRUD 基本流程（含 delta 计数）
#   2. 悬空 topicId（无 .jsonl）的容错
#   3. getHistory 对已有/不存在 transcript 的处理
#   4. 快速连续 create 数据完整性（测试插件 mutex）
#   5. 快速连续 create + delete 混合操作
#   6. delete 清理验证
#   7. generateTitle 端到端（可选，需 LLM 可用）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_lib.sh"

PASS=0
FAIL=0
SKIP=0
CREATED_TOPIC_IDS=()

# --- 工具函数 ---

gw_call() {
	local method="$1"
	shift
	openclaw gateway call "$method" "$@" --json 2>/dev/null
}

gw_call_params() {
	local method="$1"
	local params="$2"
	shift 2
	gw_call "$method" --params "$params" "$@"
}

assert_eq() {
	local actual="$1" expected="$2" msg="$3"
	if [[ "$actual" == "$expected" ]]; then
		PASS=$((PASS + 1))
		echo "  PASS: $msg"
	else
		FAIL=$((FAIL + 1))
		echo "  FAIL: $msg (expected='$expected', actual='$actual')"
	fi
}

assert_ge() {
	local actual="$1" threshold="$2" msg="$3"
	if [[ "$actual" -ge "$threshold" ]]; then
		PASS=$((PASS + 1))
		echo "  PASS: $msg (actual=$actual)"
	else
		FAIL=$((FAIL + 1))
		echo "  FAIL: $msg (expected >= $threshold, actual=$actual)"
	fi
}

json_field() {
	python3 -c "import sys,json; d=json.load(sys.stdin); print($1)" 2>/dev/null <<< "$2"
}

topic_count() {
	local result
	result=$(gw_call_params coclaw.topics.list '{"agentId":"main"}')
	json_field "len(d['topics'])" "$result"
}

track_topic() {
	CREATED_TOPIC_IDS+=("$1")
}

cleanup_topics() {
	echo ""
	echo "--- Cleanup ---"
	for tid in "${CREATED_TOPIC_IDS[@]}"; do
		gw_call_params coclaw.topics.delete "{\"topicId\":\"$tid\"}" >/dev/null 2>&1 || true
	done
	echo "Cleaned ${#CREATED_TOPIC_IDS[@]} topic(s)"
}

trap cleanup_topics EXIT

# --- 前置检查 ---

echo "=== Topic Integration Tests ==="
echo ""

echo "[Pre-check] Gateway status..."
if ! openclaw gateway status >/dev/null 2>&1; then
	echo "FATAL: Gateway is not running. Start it first."
	exit 1
fi
echo "  Gateway OK"
echo ""

# --- Test 1: CRUD 基本流程 ---

echo "[Test 1] CRUD 基本流程"

COUNT_BEFORE=$(topic_count)

# create
RESULT=$(gw_call_params coclaw.topics.create '{"agentId":"main"}')
TOPIC_1=$(json_field "d['topicId']" "$RESULT")
track_topic "$TOPIC_1"
assert_eq "$(echo -n "$TOPIC_1" | wc -c | tr -d ' ')" "36" "create 返回 UUID (36 chars)"

# list（delta +1）
COUNT_AFTER=$(topic_count)
EXPECTED=$((COUNT_BEFORE + 1))
assert_eq "$COUNT_AFTER" "$EXPECTED" "create 后 list 数量 +1"

# get
GET_RESULT=$(gw_call_params coclaw.topics.get "{\"topicId\":\"$TOPIC_1\"}")
GET_TITLE=$(json_field "str(d['topic']['title'])" "$GET_RESULT")
assert_eq "$GET_TITLE" "None" "新建 topic title 为 null"
GET_AID=$(json_field "d['topic']['agentId']" "$GET_RESULT")
assert_eq "$GET_AID" "main" "topic agentId 为 main"

# get nonexistent
GET_NONE=$(gw_call_params coclaw.topics.get '{"topicId":"nonexistent-uuid"}')
GET_NONE_TOPIC=$(json_field "str(d['topic'])" "$GET_NONE")
assert_eq "$GET_NONE_TOPIC" "None" "get 不存在的 topicId 返回 null"

echo ""

# --- Test 2: 悬空 topicId（无 .jsonl） ---

echo "[Test 2] 悬空 topicId（无 .jsonl）的 getHistory"

HISTORY=$(gw_call_params coclaw.topics.getHistory "{\"topicId\":\"$TOPIC_1\"}")
TOTAL=$(json_field "d['total']" "$HISTORY")
assert_eq "$TOTAL" "0" "悬空 topic getHistory total=0"
MSGS_LEN=$(json_field "len(d['messages'])" "$HISTORY")
assert_eq "$MSGS_LEN" "0" "悬空 topic getHistory messages=[]"

# 不存在于 coclaw-topics.json 的任意 UUID 也应正常返回空
HISTORY_RAND=$(gw_call_params coclaw.topics.getHistory '{"topicId":"00000000-0000-0000-0000-000000000000"}')
TOTAL_RAND=$(json_field "d['total']" "$HISTORY_RAND")
assert_eq "$TOTAL_RAND" "0" "完全不存在的 UUID getHistory total=0"

echo ""

# --- Test 3: 发送消息后的 getHistory ---

echo "[Test 3] 发送消息 → getHistory"

RESULT2=$(gw_call_params coclaw.topics.create '{"agentId":"main"}')
TOPIC_2=$(json_field "d['topicId']" "$RESULT2")
track_topic "$TOPIC_2"

IDEMPOTENCY=$(python3 -c "import uuid; print(uuid.uuid4())")
AGENT_RESULT=$(gw_call agent --params "{\"sessionId\":\"$TOPIC_2\",\"message\":\"hello, just say hi back briefly\",\"idempotencyKey\":\"$IDEMPOTENCY\"}" --expect-final --timeout 60000 2>/dev/null) || true

HISTORY2=$(gw_call_params coclaw.topics.getHistory "{\"topicId\":\"$TOPIC_2\"}")
TOTAL2=$(json_field "d['total']" "$HISTORY2")
# 至少 header + user message + assistant response
assert_ge "$TOTAL2" 3 "getHistory total >= 3"

echo ""

# --- Test 4: 快速连续 create（测试 mutex 串行化） ---
# 注意：使用串行快速调用而非真并发，因为每次 `openclaw gateway call`
# 都会创建新 WS 连接，过多并发会导致连接竞争。
# 插件层的真并发保护已在单元测试中通过 Promise.all 验证。

echo "[Test 4] 快速连续 create（10 个）数据完整性"

COUNT_BEFORE4=$(topic_count)

RAPID_IDS=()
for i in $(seq 1 10); do
	R=$(gw_call_params coclaw.topics.create '{"agentId":"main"}')
	TID=$(json_field "d['topicId']" "$R")
	RAPID_IDS+=("$TID")
	track_topic "$TID"
done

assert_eq "${#RAPID_IDS[@]}" "10" "快速连续创建 10 个 topic 全部成功"

COUNT_AFTER4=$(topic_count)
EXPECTED4=$((COUNT_BEFORE4 + 10))
assert_eq "$COUNT_AFTER4" "$EXPECTED4" "快速创建后 list 数量正确 ($EXPECTED4)"

# 检查无重复 ID
UNIQUE_COUNT=$(printf '%s\n' "${RAPID_IDS[@]}" | sort -u | wc -l | tr -d ' ')
assert_eq "$UNIQUE_COUNT" "10" "快速创建的 topicId 无重复"

# 验证磁盘文件完整性
TOPICS_FILE="$HOME/.openclaw/agents/main/sessions/coclaw-topics.json"
if [[ -f "$TOPICS_FILE" ]]; then
	DISK_COUNT=$(python3 -c "import json; d=json.load(open('$TOPICS_FILE')); print(len(d['topics']))")
	assert_eq "$DISK_COUNT" "$COUNT_AFTER4" "磁盘文件 topics 数量与内存一致"
else
	FAIL=$((FAIL + 1))
	echo "  FAIL: coclaw-topics.json 不存在"
fi

echo ""

# --- Test 5: 快速连续 create + delete 混合 ---

echo "[Test 5] 快速连续 create + delete 混合操作"

# 创建 5 个准备删除的
DELETE_IDS=()
for i in $(seq 1 5); do
	R=$(gw_call_params coclaw.topics.create '{"agentId":"main"}')
	DID=$(json_field "d['topicId']" "$R")
	DELETE_IDS+=("$DID")
	track_topic "$DID"
done

COUNT_MID=$(topic_count)

# 交替 create 和 delete
NEW_IDS5=()
for i in $(seq 0 4); do
	# delete 第 i 个
	gw_call_params coclaw.topics.delete "{\"topicId\":\"${DELETE_IDS[$i]}\"}" >/dev/null 2>&1
	# create 新的
	R=$(gw_call_params coclaw.topics.create '{"agentId":"main"}')
	TID=$(json_field "d['topicId']" "$R")
	NEW_IDS5+=("$TID")
	track_topic "$TID"
done

COUNT_AFTER5=$(topic_count)
# +5 create -5 delete = 不变
assert_eq "$COUNT_AFTER5" "$COUNT_MID" "交替 create+delete 后数量不变 ($COUNT_MID)"

# 被删除的不应存在
ALL_DELETED=true
for did in "${DELETE_IDS[@]}"; do
	GR=$(gw_call_params coclaw.topics.get "{\"topicId\":\"$did\"}")
	GT=$(json_field "str(d['topic'])" "$GR")
	if [[ "$GT" != "None" ]]; then
		ALL_DELETED=false
		FAIL=$((FAIL + 1))
		echo "  FAIL: deleted topic $did still exists"
	fi
done
if $ALL_DELETED; then
	PASS=$((PASS + 1))
	echo "  PASS: 5 deleted topics confirmed gone"
fi

echo ""

# --- Test 6: delete 清理 .jsonl ---

echo "[Test 6] delete 清理 .jsonl 文件"

DELETE_OK=$(gw_call_params coclaw.topics.delete "{\"topicId\":\"$TOPIC_2\"}")
DELETE_STATUS=$(json_field "d['ok']" "$DELETE_OK")
assert_eq "$DELETE_STATUS" "True" "delete 有 .jsonl 的 topic 返回 ok"

# 再次 getHistory 应返回空（.jsonl 已被删除）
HISTORY3=$(gw_call_params coclaw.topics.getHistory "{\"topicId\":\"$TOPIC_2\"}")
TOTAL3=$(json_field "d['total']" "$HISTORY3")
assert_eq "$TOTAL3" "0" "delete 后 getHistory total=0"

# 重复 delete 不存在的 topic 也应安全
DELETE_AGAIN=$(gw_call_params coclaw.topics.delete "{\"topicId\":\"$TOPIC_2\"}")
DELETE_AGAIN_OK=$(json_field "d['ok']" "$DELETE_AGAIN")
assert_eq "$DELETE_AGAIN_OK" "False" "重复 delete 返回 ok=false"

echo ""

# --- Test 7: generateTitle（可选，需 LLM 可用） ---

echo "[Test 7] generateTitle 端到端"

RESULT7=$(gw_call_params coclaw.topics.create '{"agentId":"main"}')
TOPIC_7=$(json_field "d['topicId']" "$RESULT7")
track_topic "$TOPIC_7"

IDEMPOTENCY7=$(python3 -c "import uuid; print(uuid.uuid4())")
AGENT7=$(gw_call agent --params "{\"sessionId\":\"$TOPIC_7\",\"message\":\"用 Python 实现一个简单的 Web 服务器\",\"idempotencyKey\":\"$IDEMPOTENCY7\"}" --expect-final --timeout 60000 2>/dev/null) || true

if [[ -z "$AGENT7" ]]; then
	SKIP=$((SKIP + 1))
	echo "  SKIP: agent 调用失败（LLM 不可用？）"
else
	TITLE_RESULT=$(gw_call_params coclaw.topics.generateTitle "{\"topicId\":\"$TOPIC_7\"}" --expect-final --timeout 60000 2>/dev/null) || true
	if [[ -z "$TITLE_RESULT" ]]; then
		SKIP=$((SKIP + 1))
		echo "  SKIP: generateTitle 调用失败"
	else
		TITLE=$(json_field "d.get('title','')" "$TITLE_RESULT")
		if [[ -n "$TITLE" && "$TITLE" != "None" && "$TITLE" != "" ]]; then
			PASS=$((PASS + 1))
			echo "  PASS: generateTitle 返回标题='$TITLE'"

			# 验证持久化
			GET7=$(gw_call_params coclaw.topics.get "{\"topicId\":\"$TOPIC_7\"}")
			PERSISTED=$(json_field "d['topic']['title']" "$GET7")
			assert_eq "$PERSISTED" "$TITLE" "generateTitle 持久化到元信息"
		else
			FAIL=$((FAIL + 1))
			echo "  FAIL: generateTitle 返回空标题 (result=$TITLE_RESULT)"
		fi
	fi
fi

echo ""

# --- 汇总 ---

echo "=== Results ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo "  SKIP: $SKIP"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
	echo "FAILED"
	exit 1
fi

echo "ALL PASSED"
