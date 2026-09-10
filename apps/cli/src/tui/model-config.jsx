import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { clean } from "./markdown.js";
import { editDraft } from "./input.js";
import { modelFields, modelForm, modelTargets, saveModelConfig, selectedAgent } from "./model-config.js";

/** A bounded live panel; secret fields remain masked throughout editing. */
export function ModelConfig({ client, initialTarget, currentAgentId, rows, columns, paused, onClose }) {
  const [settings, setSettings] = useState(null);
  const [targets, setTargets] = useState([]);
  const [target, setTarget] = useState(null);
  const [form, setForm] = useState({});
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(null);
  const [choices, setChoices] = useState(null);
  const [busy, setBusy] = useState("loading");
  const [note, setNote] = useState("Loading configuration…");
  const mounted = useRef(true);
  const open = (item, current) => { setTarget(item); setForm(modelForm(item, current)); setCursor(0); setNote(""); };

  useEffect(() => {
    mounted.current = true;
    void Promise.allSettled([client.call("settings.get", {}), client.call("agent.catalog", {})]).then(([config, catalog]) => {
      if (!mounted.current) return;
      if (config.status === "rejected") { setNote(config.reason.message); setBusy(false); return; }
      const entries = modelTargets(catalog.status === "fulfilled" ? catalog.value.agents : []);
      setSettings(config.value.settings); setTargets(entries); setCursor(Math.max(0, entries.findIndex((entry) => entry.id === (currentAgentId ?? "jolo")))); setBusy(false); setNote(catalog.status === "rejected" ? "Agent catalog unavailable; Jolo provider can still be configured." : "");
      if (initialTarget) {
        const item = entries.find((entry) => entry.id === (initialTarget === "openai" ? "jolo" : initialTarget));
        if (item) { open(item, config.value.settings); if (initialTarget === "openai") setForm((value) => ({ ...value, name: "openai" })); }
        else setNote(`Unknown configuration: ${initialTarget}. Choose one below.`);
      }
    });
    return () => { mounted.current = false; };
  }, [client, initialTarget]);

  const fields = target ? modelFields(target, form) : [];
  const items = choices ? choices.map((model) => ({ id: model.id, label: model.displayName || model.id })) : target ? fields : targets.map((entry) => ({ id: entry.id, label: `${entry.displayName}${entry.model ? ` · ${entry.model}` : ""}${entry.id === (currentAgentId ?? "jolo") ? " · selected" : ""}${entry.available === false ? " · not installed" : ""}` }));
  const index = Math.min(cursor, Math.max(0, items.length - 1));
  const field = fields[index];
  const save = async () => {
    setBusy("saving"); setNote("Saving…");
    try { selectedAgent(target); const message = await saveModelConfig(client, target, form); if (mounted.current) await onClose(message, target); }
    catch (error) { if (mounted.current) { setNote(error.message); setBusy(false); } }
  };
  const use = async (item) => {
    setBusy("saving");
    try { selectedAgent(item); await onClose(`${item.displayName} selected`, item); }
    catch (error) { if (mounted.current) { setNote(error.message); setBusy(false); } }
  };
  const discover = async () => {
    setBusy("discovering"); setNote("Asking the agent for models…");
    try {
      const report = await client.call("agent.models", { agentId: target.id });
      if (!mounted.current) return;
      setNote(report.note || (report.models.length ? "Choose a model; use the Model field for a custom ID." : "No models reported. Enter a model ID manually."));
      if (report.models.length) { setChoices(report.models.slice(0, 200)); setCursor(0); }
    } catch (error) { if (mounted.current) setNote(error.message); }
    finally { if (mounted.current) setBusy(false); }
  };
  const cycle = (delta) => {
    const values = field.choices;
    const next = (Math.max(0, values.indexOf(form[field.id])) + delta + values.length) % values.length;
    setForm({ ...form, [field.id]: values[next] });
  };
  const move = (delta) => setCursor((index + delta + items.length) % Math.max(1, items.length));

  useInput((chunk, key) => {
    if (key.eventType === "release" || /^\[\?\d+u$/.test(chunk)) return;
    if ((key.ctrl && chunk === "c") || (key.escape && busy)) { if (busy !== "saving") onClose(); return; }
    if (rows < 8 || columns < 32) { if (key.escape) onClose(); return; }
    if (busy) return;
    if (editing) {
      if (key.escape) { setEditing(null); return; }
      if (key.return || key.tab) {
        setForm({ ...form, [editing.id]: editing.value }); setEditing(null);
        if (key.tab) move(key.shift ? -1 : 1);
        return;
      }
      if (key.ctrl && chunk === "u") { setEditing({ ...editing, value: "", replace: false }); return; }
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.home || key.end || key.pageUp || key.pageDown) return;
      const pastedLine = /[\r\n]/.test(chunk);
      const value = editDraft(editing.replace && (key.backspace || key.delete || (!key.ctrl && !key.meta && chunk)) ? "" : editing.value, pastedLine ? chunk.split(/[\r\n]/)[0] : chunk, key).slice(0, field.limit ?? 200);
      if (pastedLine) { setForm({ ...form, [editing.id]: value }); setEditing(null); return; }
      setEditing({ ...editing, value, replace: false });
      return;
    }
    if (key.escape) {
      if (choices) { setChoices(null); setCursor(0); setNote(""); }
      else if (target) { setTarget(null); setForm({}); setCursor(0); setNote(""); }
      else onClose();
      return;
    }
    if (key.upArrow || (key.tab && key.shift)) { move(-1); return; }
    if (key.downArrow || key.tab) { move(1); return; }
    if (!target && chunk === "e" && targets[index]) { open(targets[index], settings); return; }
    if (target && !choices && field?.choices && (key.leftArrow || key.rightArrow)) { cycle(key.leftArrow ? -1 : 1); return; }
    if (!key.return) return;
    if (choices) { setForm({ ...form, model: choices[index].id }); setChoices(null); setCursor(0); setNote(""); }
    else if (!target && targets[index]) void use(targets[index]);
    else if (field?.id === "save") void save();
    else if (field?.id === "discover") void discover();
    else if (field?.choices) cycle(1);
    else if (field) setEditing({ id: field.id, value: form[field.id] ?? "", replace: true });
  }, { isActive: !paused });

  const count = Math.max(1, rows - 6);
  const start = Math.max(0, Math.min(index - Math.floor(count / 2), items.length - count));
  const valueFor = (item) => {
    if (item.action || !target || choices) return "";
    const value = editing?.id === item.id ? editing.value : form[item.id];
    if (item.secret) return value ? "••••••••" : item.placeholder;
    return clean(value || item.placeholder || "default");
  };
  if (rows < 8 || columns < 32) return <Text wrap="truncate-end">Enlarge terminal · Esc closes models</Text>;
  return <Box flexDirection="column" width="100%" borderStyle="round" borderColor="gray" paddingX={1}>
    <Text bold wrap="truncate-end">Models{target ? ` / ${clean(target.displayName)}` : ""}</Text>
    <Text dimColor wrap="truncate-end">{target?.id === "jolo" ? "Shared provider settings · next run" : target ? "Blank values use the agent’s default" : "Choose the agent for your prompts"}</Text>
    {items.slice(start, start + count).map((item, offset) => <Text key={item.id} bold={start + offset === index} wrap="truncate-end">
      {start + offset === index ? "› " : "  "}{clean(item.label)}{valueFor(item) ? `  ${valueFor(item)}` : ""}{editing?.id === item.id ? " ▏" : ""}
    </Text>)}
    <Text dimColor wrap="truncate-end">{clean(note || (paused ? "Answer the pending permission first" : editing ? "Type to replace · Enter apply · Esc cancel · Ctrl+U clear" : !target ? "↑/↓ select · Enter use · e configure · Esc close" : "↑/↓ select · Enter edit/save · ←/→ options · Esc back"))}</Text>
    {items.length > count && <Text dimColor>{index + 1}/{items.length}</Text>}
  </Box>;
}
