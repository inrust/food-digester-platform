import { PublishCommand } from '@aws-sdk/client-iot-data-plane';
import { assert, describe, test } from 'vitest';
import { createIotDataPublisher } from '../src/iot-data-publisher.js';

describe('createIotDataPublisher', () => {
  test('以 QoS 1 和 UTF-8 payload 调用 AWS IoT Data Plane', async () => {
    const sent: unknown[] = [];
    const publisher = createIotDataPublisher({
      endpoint: 'account-ats.iot.ap-southeast-1.amazonaws.com',
      client: {
        async send(command: unknown) {
          sent.push(command);
          return {};
        },
      } as never,
    });
    await publisher.publish({
      topic: 'bnx/device/dev-1/notification',
      qos: 1,
      payload: '{"data":{"type":"CERTIFICATE_ROTATION_REQUIRED"}}',
    });

    const command = sent[0] as PublishCommand;
    assert.instanceOf(command, PublishCommand);
    assert.equal(command.input.topic, 'bnx/device/dev-1/notification');
    assert.equal(command.input.qos, 1);
    assert.equal(
      Buffer.from(command.input.payload as Uint8Array).toString('utf8'),
      '{"data":{"type":"CERTIFICATE_ROTATION_REQUIRED"}}',
    );
  });
});
