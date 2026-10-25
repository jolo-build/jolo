// Claude's questions to the person, as opposed to its permission prompts.
//
// In host mode Claude Code sends AskUserQuestion and plan approval (ExitPlanMode) as ordinary can_use_tool requests
// marked requires_user_interaction; initialize.supportedDialogKinds changes nothing for them. The answer travels inside
// the permission answer: allow with the tool's input plus the person's response (AskUserQuestion: `answers`, keyed by
// the question's text, each the chosen option's label), or deny with a message. `{ behavior: "cancelled" }` is refused
// as invalid. Shapes recorded against Claude Code 2.1.304 in this directory's README.md, "Dialogs".

/** Tools whose request is a question for the person, whether or not Claude marks it as one. */
export const DIALOG_TOOLS = Object.freeze(["AskUserQuestion", "ExitPlanMode"]);

/** Whether a can_use_tool request asks the person rather than asks for permission. */
export const isDialogRequest = (request) => request?.requires_user_interaction === true || DIALOG_TOOLS.includes(request?.tool_name);

/**
 * What Claude is answered for a settled dialog: the person's answer, or their refusal to answer. Null for one that was
 * cancelled, which the caller answers itself (a Stop) or not at all (Claude took the question back).
 */
export const dialogControlResponse = (dialog) => {
  if (dialog.state === "answered") return { behavior: "allow", updatedInput: { ...dialog.input, ...dialog.response } };
  if (dialog.state === "dismissed") return { behavior: "deny", message: dialog.response.message };
  return null;
};
