/** AWS IoT Data Plane MQTT 发布适配器（下行 Outbox/OTA 生产组合根使用）。 */
import { IoTDataPlaneClient, PublishCommand } from '@aws-sdk/client-iot-data-plane';

export interface MqttPublishInput {
  readonly topic: string;
  readonly payload: string;
  readonly qos: 1;
}

export interface MqttMessageSender {
  publish(input: MqttPublishInput): Promise<void | { readonly providerMessageId?: string }>;
}

export interface IotDataPublisherConfig {
  /** 账号专属 IoT Data-ATS Endpoint，格式为主机名或 https URL。 */
  readonly endpoint: string;
  readonly region?: string;
  readonly client?: IoTDataPlaneClient;
}

export function createIotDataPublisher(config: IotDataPublisherConfig): MqttMessageSender {
  const endpoint = config.endpoint.startsWith('https://') ? config.endpoint : `https://${config.endpoint}`;
  const client =
    config.client ?? new IoTDataPlaneClient({ endpoint, ...(config.region ? { region: config.region } : {}) });
  return {
    async publish(input) {
      const output = await client.send(
        new PublishCommand({
          topic: input.topic,
          qos: input.qos,
          payload: Buffer.from(input.payload, 'utf8'),
        }),
      );
      return output?.$metadata?.requestId ? { providerMessageId: output.$metadata.requestId } : {};
    },
  };
}
