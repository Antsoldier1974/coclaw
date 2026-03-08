import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';

import { saveHomedir, setHomedir, restoreHomedir } from './homedir-mock.helper.js';

test('saveHomedir/setHomedir/restoreHomedir should manage HOME and USERPROFILE', () => {
	const saved = saveHomedir();

	setHomedir('/tmp/mock-home');
	assert.equal(process.env.HOME, '/tmp/mock-home');
	assert.equal(process.env.USERPROFILE, '/tmp/mock-home');
	// os.homedir() 应返回 mock 路径
	assert.equal(os.homedir(), '/tmp/mock-home');

	restoreHomedir(saved);
	assert.equal(process.env.HOME, saved.HOME);
	assert.equal(process.env.USERPROFILE, saved.USERPROFILE);
});

test('restoreHomedir should delete env var when saved value was undefined', () => {
	const saved = saveHomedir();
	const originalHome = process.env.HOME;

	// 模拟 Windows 场景：HOME 可能不存在
	delete process.env.HOME;
	const savedWithoutHome = saveHomedir();

	setHomedir('/tmp/test');
	assert.equal(process.env.HOME, '/tmp/test');

	restoreHomedir(savedWithoutHome);
	assert.equal(process.env.HOME, undefined);

	// 恢复原始状态
	restoreHomedir(saved);
	assert.equal(process.env.HOME, originalHome);
});
