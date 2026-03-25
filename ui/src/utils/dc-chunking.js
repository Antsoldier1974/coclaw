/**
 * DataChannel 应用层分片/重组（浏览器侧）
 * 协议：普通消息用 string，分片消息用 binary（ArrayBuffer）
 *
 * 二进制帧格式：
 *   Byte 0:   flag (0x01=BEGIN, 0x00=MIDDLE, 0x02=END)
 *   Byte 1-4: msgId (uint32 BE)
 *   Byte 5+:  UTF-8 数据片段
 */

export const FLAG_BEGIN = 0x01;
export const FLAG_MIDDLE = 0x00;
export const FLAG_END = 0x02;
export const HEADER_SIZE = 5; // 1 flag + 4 msgId

/** 单条消息重组缓冲区上限 */
export const MAX_REASSEMBLY_BYTES = 50 * 1024 * 1024;
/** 单条消息最大 chunk 数 */
export const MAX_CHUNKS_PER_MSG = 10_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 将 JSON 字符串按需分片为 ArrayBuffer 数组
 * @param {string} jsonStr - 已序列化的 JSON 字符串
 * @param {number} maxMessageSize - 对端声明的 maxMessageSize
 * @param {() => number} getNextMsgId - 获取下一个 msgId
 * @returns {null | ArrayBuffer[]} null 表示不需要分片，否则返回 chunk 数组
 */
export function buildChunks(jsonStr, maxMessageSize, getNextMsgId) {
	const fullBytes = encoder.encode(jsonStr);
	if (fullBytes.byteLength <= maxMessageSize) return null;

	const chunkPayloadSize = maxMessageSize - HEADER_SIZE;
	if (chunkPayloadSize <= 0) {
		throw new Error(`maxMessageSize (${maxMessageSize}) too small for chunking header`);
	}

	const msgId = getNextMsgId();
	const totalChunks = Math.ceil(fullBytes.byteLength / chunkPayloadSize);
	console.debug(`[dc-chunking] chunking msgId=${msgId}: ${fullBytes.byteLength} bytes → ${totalChunks} chunks (maxMsgSize=${maxMessageSize})`);
	const chunks = [];

	for (let i = 0; i < totalChunks; i++) {
		const start = i * chunkPayloadSize;
		const end = Math.min(start + chunkPayloadSize, fullBytes.byteLength);
		const flag = i === 0 ? FLAG_BEGIN : (i === totalChunks - 1 ? FLAG_END : FLAG_MIDDLE);

		const chunk = new Uint8Array(HEADER_SIZE + (end - start));
		chunk[0] = flag;
		new DataView(chunk.buffer).setUint32(1, msgId, false); // BE
		chunk.set(fullBytes.subarray(start, end), HEADER_SIZE);

		chunks.push(chunk.buffer);
	}
	return chunks;
}

/**
 * 创建分片重组器
 * @param {(jsonStr: string) => void} onComplete - 完整消息回调
 * @returns {{ feed: (data: string|ArrayBuffer) => void, reset: () => void }}
 */
export function createReassembler(onComplete) {
	/** @type {Map<number, { chunks: Uint8Array[], totalBytes: number }>} */
	const pending = new Map();

	function feed(data) {
		// string = 普通消息
		if (typeof data === 'string') {
			onComplete(data);
			return;
		}

		// binary = 分片 chunk
		const buf = new Uint8Array(data);
		if (buf.length < HEADER_SIZE) return;

		const flag = buf[0];
		const msgId = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(1, false);
		const payload = buf.subarray(HEADER_SIZE);

		if (flag === FLAG_BEGIN) {
			pending.set(msgId, { chunks: [payload], totalBytes: payload.length });
			return;
		}

		const entry = pending.get(msgId);
		if (!entry) return;

		entry.totalBytes += payload.length;
		if (entry.totalBytes > MAX_REASSEMBLY_BYTES || entry.chunks.length >= MAX_CHUNKS_PER_MSG) {
			pending.delete(msgId);
			return;
		}

		entry.chunks.push(payload);

		if (flag === FLAG_END) {
			pending.delete(msgId);
			const totalLen = entry.chunks.reduce((s, c) => s + c.length, 0);
			const merged = new Uint8Array(totalLen);
			let offset = 0;
			for (const c of entry.chunks) {
				merged.set(c, offset);
				offset += c.length;
			}
			console.debug(`[dc-chunking] reassembled msgId=${msgId}: ${entry.chunks.length} chunks, ${totalLen} bytes`);
			onComplete(decoder.decode(merged));
		}
	}

	function reset() {
		pending.clear();
	}

	return { feed, reset };
}
