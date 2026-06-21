import type { BotInstance } from "./database.js";

/** API view of saved bot config — secrets never returned in full. */
export type BotInstanceConfigView = BotInstance & {
  hasServerPassword: boolean;
  hasChannelPassword: boolean;
  hasTs6ApiKey: boolean;
  hasIdentity: boolean;
};

/** Strip TS credentials from admin GET responses. */
export function redactBotInstanceSecrets(instance: BotInstance): BotInstanceConfigView {
  return {
    ...instance,
    serverPassword: "",
    channelPassword: "",
    ts6ApiKey: "",
    identity: undefined,
    hasServerPassword: !!instance.serverPassword,
    hasChannelPassword: !!instance.channelPassword,
    hasTs6ApiKey: !!instance.ts6ApiKey,
    hasIdentity: !!instance.identity,
  };
}

/** Empty string means "leave unchanged" on bot config update. */
export function mergeBotSecret(
  incoming: string | undefined,
  existing: string,
): string {
  if (incoming === undefined || incoming === "") return existing;
  return incoming;
}