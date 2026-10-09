# Universal Skill Orchestrator & Token-Efficiency Rule

## Scope
Active globally across all directories, projects, and empty folders.

## Workflow Pipeline
Whenever a user prompt is received:
1. **Skill Discovery**: Match the request against available skills:
   - Features / Bug fixes: Activate `get-shit-done` + `ralph-loop` + `coderabbit-review`.
   - Links / Research / Social URLs: Activate `agent-reach` (Jina Reader / OpenCLI).
   - System Design / Diagrams / Flowcharts: Activate `archify` / `agency-knowledge-graph-engineer`.
   - Domain work: Activate matching `agency-*` skills (e.g., `agency-ui-designer`, `agency-backend-architect`, `agency-mobile-app-builder`).
2. **Execution Contract**:
   - Decompose into phases (GSD).
   - Verify every step with running tests/code outputs (Ralph Loop).
   - Review diffs before git commit (CodeRabbit).
3. **Token Conservation**:
   - Progressive loading only when triggered.
   - Concise responses without polite filler.
   - Always reference files via `file:///` markdown links.
