---
name: prompts-chat
description: >-
  Open-source prompts, skills, and workflow intelligence library (prompts.chat).
  Provides instant access to 140,000+ community-curated system prompts, expert personas,
  and agentic workflows via Model Context Protocol (MCP) and API for writing, coding,
  security, research, and design.
---

# Prompts.chat — Open-Source Prompt & Workflow Intelligence

`prompts.chat` (f.k.a. Awesome ChatGPT Prompts) connects AI agents directly to a massive
open-source repository of expert role prompts, specialized task workflows, and meta-prompts.
Instead of manually searching and copying prompts, the agent queries the library dynamically.

## Core Capabilities

1. **Semantic Prompt Search**:
   - Search prompts by keyword, domain (coding, DevOps, security, UI/UX, data analysis), tag, or persona.
2. **Dynamic Template Substitution**:
   - Automatically populates template variables (`${variable}`, `[argument]`) based on the active user context.
3. **MCP Tool Integration**:
   - Integrates directly via the `@fkadev/prompts.chat-mcp` MCP server configured in `~/.gemini/config/mcp_config.json`.
   - Accesses tools: `search_prompts`, `get_prompt`, and prompt list capabilities.

## Workflow Integration

When tackling specialized tasks where a specialized persona or domain prompt is needed:
1. Query `prompts.chat` for the matching expert role (e.g., "Senior PostgreSQL DBA", "OAuth 2.0 Security Auditor", "System Sequence Designer").
2. Retrieve the structured workflow guidelines.
3. Apply the expert instructions directly to the task execution.
