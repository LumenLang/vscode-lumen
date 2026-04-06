# VSCode extension for Lumen

VS Code extension providing language support for **Lumen** (`.luma` files).

It is available at: https://marketplace.visualstudio.com/items?itemName=lumenlang.lumenlang to download.

## Features

### Completions

Context-aware suggestions that change based on where you are in the script. Events, statements, expressions, variables, blocks, type bindings, and MiniColorize tags are all covered.

### Hover

Hover over any statement, event, block, or variable to see its documentation. Descriptions, categories, available variables, and examples show up inline.

### Highlighting

Full semantic token support. Keywords, variables, types, events, properties.

### Diagnostics

**100% Accurate** real-time error and warning detection powered by Lumen Headless. Get identical validation to a real Minecraft server, but faster and in a more lightweight way.

### Document Symbols

The outline view lists all blocks, commands, events, data classes, and variable declarations with proper nesting.

### Go to Definition

Jump to where a variable was declared.

### Document Colors

Hex colors inside MiniColorize strings show inline previews with a color picker.

## Requirements

- VS Code 1.80+
- Java 17+ is needed; the extension will download Java 21 if needed.

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `lumen.validation.enabled` | `boolean` | `true` | Enable validation via Lumen Headless (100% accurate diagnostics, identical plugin pipeline to a real server, without needing a Minecraft server running). |
| `lumen.validation.trigger` | `"schedule"` \| `"save"` | `"schedule"` | When to run validation. `"schedule"` validates on a fixed interval (skips if content hasn't changed). `"save"` only validates when the file is saved. |
| `lumen.validation.frequency` | `integer` | `2000` | How often (in ms) to re-validate on schedule. Only applies when trigger is `"schedule"`. Min 500, max 30000. |
| `lumen.lsp.diagnostics` | `boolean` | `false` | Allow the Lumen LSP to show its own diagnostics alongside Headless validation. LSP diagnostics are less accurate. |
