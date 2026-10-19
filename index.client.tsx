import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AutoLabelSettings } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "preferences", title: "Auto labels", icon: "Tags", Component: AutoLabelSettings });
  client.addCommandCenterItem({ id: "settings", title: "Auto labels settings", icon: "Tags", context: "global", onSelect({ openSettings }) { openSettings("preferences"); } });
  return () => {};
}
