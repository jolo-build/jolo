// Prompt draft and recall for the interactive client. Bounded by entries and by
// characters so a long session cannot grow the client's memory without limit.
import { editDraft } from "./input.js";

export const MAX_PROMPT_HISTORY = 50;
export const MAX_PROMPT_HISTORY_CHARS = 128 * 1024;

function retain(prompts) {
  const history = [];
  let size = 0;
  for (let i = prompts.length - 1; i >= 0 && history.length < MAX_PROMPT_HISTORY; i--) {
    const prompt = prompts[i];
    if (typeof prompt !== "string" || !prompt.trim() || prompt === history[0]) continue;
    if (size + prompt.length > MAX_PROMPT_HISTORY_CHARS) break;
    history.unshift(prompt);
    size += prompt.length;
  }
  return history;
}

export const createPromptState = () => ({ value: "", history: [], index: null, draft: "" });

// Navigation is independent of transcript scrolling. Recalled entries are editable copies;
// passing the newest entry restores the draft saved on the first Up press.
/** @param {{ value: string, history: string[], index: number | null, draft: string }} state */
export function promptReducer(state, action) {
  switch (action.type) {
    case "seed": {
      const history = retain([...action.prompts, ...state.history]);
      const index = state.index === null ? null : Math.max(0, state.index + history.length - state.history.length);
      return { ...state, history, index };
    }
    case "submit":
      return { value: "", history: retain([...state.history, action.prompt]), index: null, draft: "" };
    case "clear":
      return { ...state, value: "", index: null, draft: "" };
    case "edit":
      return { ...state, value: editDraft(state.value, action.chunk, action.key) };
    case "previous": {
      if (!state.history.length || state.index === 0) return state;
      const index = (state.index ?? state.history.length) - 1;
      return { ...state, index, value: state.history[index], draft: state.index === null ? state.value : state.draft };
    }
    case "next": {
      if (state.index === null) return state;
      const index = state.index + 1;
      return index < state.history.length
        ? { ...state, index, value: state.history[index] }
        : { ...state, index: null, value: state.draft, draft: "" };
    }
    default: return state;
  }
}
