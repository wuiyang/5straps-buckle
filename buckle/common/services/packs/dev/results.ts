export const RESULT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  lsp_discover: '{ servers: Array<{ pid, serverId, commandLine, attach, port }> }',
  lsp_definition: '{ locations } (the language server\'s answer)',
  lsp_references: '{ locations } (the language server\'s answer)',
  lsp_hover: '{ hover } (the language server\'s answer)',
  lsp_rename: '{ workspaceEdit } (the language server\'s answer, not applied)',
  lsp_diagnostics: '{ uri, diagnostics: object[] }',
}
