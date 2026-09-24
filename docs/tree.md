# crossref-mcp-server - Directory Structure

Generated on: 2026-09-24 07:40:12

```text
crossref-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   ├── split-changelog.ts
│   └── tree.ts
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── get-member.tool.ts
│   │       │   ├── get-prefix.tool.ts
│   │       │   ├── get-references.tool.ts
│   │       │   ├── get-work.tool.ts
│   │       │   ├── index.ts
│   │       │   ├── search-funders.tool.ts
│   │       │   ├── search-journals.tool.ts
│   │       │   └── search-works.tool.ts
│   │       ├── blank-input.ts
│   │       ├── markdown-text.ts
│   │       └── work-locators.ts
│   ├── services/
│   │   └── crossref/
│   │       ├── crossref-service.ts
│   │       ├── html-entities.ts
│   │       ├── link-text.ts
│   │       ├── mathml.ts
│   │       ├── types.ts
│   │       └── upstream-errors.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   ├── mathml/
│   │   │   ├── 10.1090-s0002-9939-05-08007-x.json
│   │   │   ├── 10.1090-s0025-5718-00-01296-5.json
│   │   │   └── 10.1186-s13661-014-0236-x.json
│   │   └── works/
│   │       ├── __snapshots__/
│   │       │   ├── get-work-existing-fields.snap
│   │       │   └── get-work-stripped-records.snap
│   │       ├── 10.1016_j.apsusc.2007.01.131.json
│   │       ├── 10.1016_j.chemosphere.2021.130212.json
│   │       ├── 10.1016_s0140-6736_20_31180-6.json
│   │       ├── 10.1016_s0140-6736_20_31324-6.json
│   │       ├── 10.1038_s41586-020-2649-2.json
│   │       ├── 10.1101_2025.11.10.687519.json
│   │       ├── 10.1103_physrevd.109.023023.json
│   │       ├── 10.1109_icetce.2011.5774727.json
│   │       ├── 10.1364_oe.572415.json
│   │       ├── 10.1364_opticaopen.29459153.v1.json
│   │       ├── 10.20944_preprints202302.0051.v34.json
│   │       ├── 10.2139_ssrn.4944457.json
│   │       ├── 10.47094_978-65-6036-545-2.json
│   │       └── 10.7554_elife.03714.json
│   ├── helpers/
│   │   ├── content.ts
│   │   ├── crossref-responses.ts
│   │   └── scaling.ts
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   └── crossref/
│   │       ├── crossref-service.test.ts
│   │       ├── markup-regions.test.ts
│   │       ├── mathml.test.ts
│   │       └── upstream-classification.test.ts
│   └── tools/
│       ├── date-surface.test.ts
│       ├── get-member.tool.test.ts
│       ├── get-prefix.tool.test.ts
│       ├── get-references.tool.test.ts
│       ├── get-work-records.test.ts
│       ├── get-work.tool.test.ts
│       ├── input-strictness.test.ts
│       ├── markdown-surface.test.ts
│       ├── markdown-text.test.ts
│       ├── mathml-surface.test.ts
│       ├── search-blank-inputs.test.ts
│       ├── search-empty-pages.test.ts
│       ├── search-funders.tool.test.ts
│       ├── search-journals.tool.test.ts
│       ├── search-works-fields.test.ts
│       ├── search-works.tool.test.ts
│       └── works-cursor-walk.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
