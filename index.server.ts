import type { PluginServerContext } from "@getpaseo/plugin/server";
import { preferences, statusRpc, syncRpc, clearRpc } from "./shared/contracts";
import { AutoLabelService } from "./server/service";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(preferences);
  const service = new AutoLabelService();
  const configure = async () => {
    const state = await settings.read();
    if (state.status === "ready") await service.configure(state.values);
    else await service.invalidSettings();
  };
  const unsubscribe = settings.subscribe(async (state) => {
    if (state.status === "ready") await service.configure(state.values);
    else await service.invalidSettings();
  });
  void configure().catch(() => service.invalidSettings());
  server.handle(statusRpc, () => service.status());
  server.handle(syncRpc, async () => { await configure(); return service.sync(); });
  server.handle(clearRpc, async () => { await configure(); return service.clear(); });
  return async () => { unsubscribe(); await service.stop(); };
}
