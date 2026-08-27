/**
 * AUTH-04 与 CT-02 契约一致性：aws-clients 的 Topic 清单必须与
 * contracts/mqtt/topic-catalog.json 完全一致（防策略与协议漂移）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assert, test } from 'vitest';
import { DOWNLINK_TOPIC_TYPES, TOPIC_PATTERN, UPLINK_TOPIC_TYPES } from '../src/iot-device-policy.js';

interface TopicCatalogEntry {
  readonly type: string;
  readonly direction: 'uplink' | 'downlink';
}

function loadCatalog(): { topicPattern: string; topics: TopicCatalogEntry[] } {
  const path = fileURLToPath(new URL('../../../contracts/mqtt/topic-catalog.json', import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('Topic 模式与 11 个 Topic 的方向清单同契约目录一致', () => {
  const catalog = loadCatalog();
  assert.equal(TOPIC_PATTERN, catalog.topicPattern);

  const uplink = catalog.topics.filter((t) => t.direction === 'uplink').map((t) => t.type);
  const downlink = catalog.topics.filter((t) => t.direction === 'downlink').map((t) => t.type);

  assert.deepEqual([...UPLINK_TOPIC_TYPES].sort(), uplink.sort());
  assert.deepEqual([...DOWNLINK_TOPIC_TYPES].sort(), downlink.sort());
});
