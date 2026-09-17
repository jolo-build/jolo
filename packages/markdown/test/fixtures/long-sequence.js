export const longSequence = `sequenceDiagram
  participant U as User
  participant A as Atlas
  participant K as Keystone API
  participant AI as AI
  participant T as Keystone Tools
  participant C as Cypho
  U->>A: Why is this asset high risk?
  A->>K: Question + conversation ID + page context
  Note over A,K: Selected company, asset or issue, time range
  K->>K: Authenticate user and validate company access
  K->>AI: Question + context + available tool definitions
  loop Gather evidence within request limits
    AI-->>K: Request a tool with structured arguments
    K->>T: Validate arguments and enforce user scope
    T->>C: Read authorized assets, issues or incidents
    C-->>T: Records and query results
    T-->>K: Evidence + source IDs + completeness
    K->>AI: Tool results
  end
  AI-->>K: Stream explanation and recommendations
  K-->>A: Stream answer with validated evidence links
  K->>K: Save conversation under user and company
  A-->>U: Sources + suggested follow-ups
  Note left of U: Open a related issue or ask another question
  Note right of C: Preserve full descriptions at the right edge
  C->>C: A final self-message whose label must fit completely inside the diagram`;
