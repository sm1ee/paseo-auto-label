import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { clearRpc, preferences, statusRpc, syncRpc } from "../shared/contracts";

const stateText = { starting: "Connecting…", watching: "Watching for changes", paused: "Paused", error: "Needs attention" };

export function AutoLabelSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(preferences);
  const getStatus = useRpc(statusRpc);
  const sync = useRpc(syncRpc);
  const clear = useRpc(clearRpc);
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ["auto-label-status"], queryFn: () => getStatus({}), refetchInterval: 4000 });
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["auto-label-status"] }); };
  const synchronize = useMutation({ mutationFn: () => sync({}), onSuccess: refresh });
  const remove = useMutation({ mutationFn: async () => {
    if (settings.status !== "ready") return;
    if (!await settings.save({ ...settings.values, enabled: false }, settings.revision)) throw new Error("Could not pause auto labels. Try again.");
    return clear({});
  }, onSuccess: refresh });
  const [home, setHome] = useState<string | null>(null);
  const text = { color: theme.colors.foreground };
  const muted = { color: theme.colors.foregroundMuted };
  const busy = synchronize.isPending || remove.isPending || settings.saving;
  if (settings.status !== "ready") return (
    <SettingsSection title="Auto labels">
      <Text style={text}>{settings.status === "loading" ? "Loading settings…" : "Could not read settings. Reload them or restore defaults."}</Text>
      {settings.status !== "loading" && <SettingsCard>
        <SettingsAction label="Reload settings" actionLabel="Reload" onPress={() => { void settings.reload(); }} />
        <SettingsAction label="Restore default settings" actionLabel="Restore" onPress={() => { void settings.reset(); }} />
      </SettingsCard>}
    </SettingsSection>
  );
  const data = status.data;
  return <View style={{ gap: 24 }}>
    <SettingsSection title="Auto labels">
      <Text style={muted}>Show the provider, model, and effort in each workspace's labels. Labels update when session settings change.</Text>
      <SettingsCard>
        <SettingsSwitch label="Auto labels" hint="Pausing keeps the labels already added." value={settings.values.enabled} disabled={busy} onValueChange={(enabled) => { void settings.save({ ...settings.values, enabled }, settings.revision).then(refresh); }} />
        <SettingsSwitch label="Include subagents" hint="Adds their configurations to the workspace's labels too." value={settings.values.includeSubagents} disabled={busy} onValueChange={(includeSubagents) => { void settings.save({ ...settings.values, includeSubagents }, settings.revision).then(refresh); }} />
      </SettingsCard>
      {settings.saveError && <Text style={text}>Could not save settings. Reload the page and try again.</Text>}
    </SettingsSection>
    <SettingsSection title="Sync">
      <SettingsCard>
        <SettingsRow label={data ? stateText[data.state] : "Connecting…"} hint={data ? `${data.labelledWorkspaces} of ${data.workspaces} workspaces labelled · ${data.configurations} configurations` : "Reading this host's status."} />
        <SettingsAction label="Sync existing workspaces" hint="Refresh labels for existing workspaces on this host." actionLabel={synchronize.isPending ? "Syncing…" : "Sync now"} disabled={busy || !settings.values.enabled} onPress={() => synchronize.mutate()} />
        <SettingsAction label="Remove generated labels" hint="Pauses syncing and removes labels added by this plugin from active workspaces. Other labels stay in place." actionLabel={remove.isPending ? "Removing…" : "Remove"} disabled={busy} onPress={() => remove.mutate()} />
      </SettingsCard>
      {(data?.error || status.isError || synchronize.isError || remove.isError) && <Text style={text}>{data?.error ?? "The request failed. Check this host's connection and try again."}</Text>}
      {data?.examples.map((name) => <Text key={name} style={muted}>{name}</Text>)}
    </SettingsSection>
    <SettingsSection title="Paseo home">
      <Text style={muted}>Leave this empty for automatic detection. Set it only if this daemon uses a different Paseo home.</Text>
      <SettingsCard>
        <SettingsInput key={settings.values.daemonHome} label="Home directory" initialValue={settings.values.daemonHome} placeholder="Automatic" disabled={busy} onChangeText={setHome} />
        <SettingsAction label="Save home directory" actionLabel="Save" disabled={busy || home === null || home === settings.values.daemonHome} onPress={() => { void settings.save({ ...settings.values, daemonHome: home?.trim() ?? "" }, settings.revision).then((saved) => { if (saved) { setHome(null); refresh(); } }); }} />
      </SettingsCard>
    </SettingsSection>
    <Text style={muted}>Labels belong to workspaces. Different main-session configurations get separate labels; identical ones share a label. Values come from Paseo's reported settings. Missing values appear as “model unknown” or “effort unknown”.</Text>
  </View>;
}
