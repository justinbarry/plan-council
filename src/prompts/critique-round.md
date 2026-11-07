# Plan Review: {{planTitle}}
File: `{{planFilePath}}`
{{#if sessionContext}}

## Context from User Session
{{{sessionContext}}}
{{/if}}

## Proposed Plan
{{{planBody}}}
{{#if referencedFiles}}

## Referenced Repository Files
Numbered working-tree excerpts captured during council initialization for paths named in the plan (line numbers reflect the current file and may be offset from plan citations):
{{#each referencedFiles}}

### `{{path}}` ({{rangeLabel}})
{{{excerptBlock}}}
{{/each}}
{{/if}}

Perform your Round {{round}} critique according to your review criteria. Be direct, rigorous, and cite specific lines or steps from the plan.
