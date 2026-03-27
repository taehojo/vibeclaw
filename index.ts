/**
 * VibeClaw — Zero-Config Skill Discovery for OpenClaw
 *
 * Connects OpenClaw to the Vibe Index ecosystem (93,600+ resources).
 * When the AI agent encounters a task it can't handle, VibeClaw searches
 * the Vibe Index catalog and recommends the right skill/plugin/MCP server
 * with a ready-to-use install command.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { Type } from "@sinclair/typebox";
import { VibeIndexClient } from "./src/vibe-index-client.js";
import type { VibeResource } from "./src/vibe-index-client.js";
import { installSkillFromGitHub, listInstalledSkills, uninstallSkill, getInstalledSkillMeta } from "./src/skill-installer.js";

function checkSecurity(skill: VibeResource): string | null {
  if (skill.cisco_scan_result && !skill.cisco_scan_result.is_safe) {
    return `BLOCKED: "${skill.name}" failed security scan. Severity: ${skill.cisco_scan_result.max_severity}. See https://vibeindex.ai`;
  }
  if (skill.security_score !== null && skill.security_score >= 25) {
    return `BLOCKED: "${skill.name}" has high security risk (score: ${skill.security_score}). See https://vibeindex.ai`;
  }
  return null;
}

function formatSecurityBadge(skill: VibeResource): string {
  if (skill.cisco_scan_result?.is_safe) return "Verified safe (Cisco scan)";
  if (skill.security_score === 0) return "Pre-scanned (no issues)";
  if (skill.security_score !== null && skill.security_score > 0 && skill.security_score < 25)
    return `Minor flags (score: ${skill.security_score})`;
  return "Scan pending";
}

function formatResource(r: VibeResource, index: number): string {
  const stars = r.star_info?.count ?? r.stars ?? 0;
  const badges: string[] = [];
  if (r.badges?.official || r.is_official) badges.push("Official");
  if (r.badges?.verified || r.is_verified) badges.push("Verified");
  if (r.badges?.trending) badges.push("Trending");
  const badgeStr = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
  const desc = r.description
    ? r.description.length > 120 ? r.description.slice(0, 120) + "..." : r.description
    : "No description";
  let result = `${index}. ${r.name} (${r.resource_type.toUpperCase()}) - ${stars} stars${badgeStr}\n`;
  result += `   ${desc}\n`;
  result += `   Security: ${formatSecurityBadge(r)}\n`;
  if (r.github_url) result += `   GitHub: ${r.github_url}\n`;
  return result;
}

const vibeClawPlugin = {
  id: "vibeclaw",
  name: "VibeClaw",
  description:
    "Zero-Config skill discovery - search, recommend, and install skills from the Vibe Index ecosystem (93,600+ resources)",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const apiKey = pluginConfig.apiKey as string | undefined;
    const client = new VibeIndexClient(apiKey);
    const searchOnly = (pluginConfig.searchOnly as boolean) ?? false;
    const allowedPublishers = (pluginConfig.allowedPublishers as string[]) ?? null;

    // vibeclaw_search
    api.registerTool({
      name: "vibeclaw_search",
      description:
        "Search the Vibe Index ecosystem (93,600+ skills, plugins, MCP servers) for capabilities. " +
        "Use when the user needs something you cannot do, or asks about available tools.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query (e.g., 'email', 'calendar', 'weather')" }),
        type: Type.Optional(Type.Union([
          Type.Literal("skill"), Type.Literal("plugin"), Type.Literal("mcp"), Type.Literal("marketplace"),
        ])),
        limit: Type.Optional(Type.Number({ description: "Results count (1-10, default 5)" })),
      }),
      async execute(_id: string, params: { query: string; type?: string; limit?: number }) {
        try {
          const result = await client.search(params.query, { type: params.type, limit: params.limit ?? 5 });
          if (!result.success || result.data.length === 0) {
            return { content: [{ type: "text" as const, text: `No results for "${params.query}" in Vibe Index.` }] };
          }
          const total = result.pagination?.total ?? result.data.length;
          let output = `Found ${total} results for "${params.query}" in Vibe Index:\n\n`;
          output += result.data.map((r, i) => formatResource(r, i + 1)).join("\n");
          output += `\nUse vibeclaw_install to install any skill.`;
          return { content: [{ type: "text" as const, text: output }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
        }
      },
    });

    // vibeclaw_install
    api.registerTool({
      name: "vibeclaw_install",
      description:
        "Install a skill from Vibe Index into OpenClaw. Downloads SKILL.md from GitHub to ~/.openclaw/skills/.",
      parameters: Type.Object({
        query: Type.String({ description: "Skill name or search query" }),
        force: Type.Optional(Type.Boolean({ description: "Reinstall if exists" })),
      }),
      async execute(_id: string, params: { query: string; force?: boolean }) {
        if (searchOnly) {
          return { content: [{ type: "text" as const, text: "Installation disabled (search-only mode)." }] };
        }
        try {
          const searchResult = await client.search(params.query, { type: "skill", limit: 1 });
          if (!searchResult.success || searchResult.data.length === 0) {
            return { content: [{ type: "text" as const, text: `Skill "${params.query}" not found in Vibe Index.` }] };
          }
          const skill = searchResult.data[0];
          if (!skill.github_owner || !skill.github_repo) {
            return { content: [{ type: "text" as const, text: `"${skill.name}" has no GitHub repo.` }] };
          }
          if (allowedPublishers?.length) {
            const allowed = allowedPublishers.map(p => p.toLowerCase());
            if (!allowed.includes((skill.github_owner).toLowerCase())) {
              return { content: [{ type: "text" as const, text: `BLOCKED: "${skill.github_owner}" not in allowlist.` }] };
            }
          }
          const sec = checkSecurity(skill);
          if (sec) return { content: [{ type: "text" as const, text: sec }] };
          const result = await installSkillFromGitHub(skill.github_owner, skill.github_repo, skill.slug || skill.name, { force: params.force });
          if (!result.success) return { content: [{ type: "text" as const, text: `Install failed: ${result.error}` }] };
          if (result.alreadyInstalled) return { content: [{ type: "text" as const, text: `"${skill.name}" already installed. Use force to reinstall.` }] };
          return { content: [{ type: "text" as const, text: `Installed "${result.skillName}"!\n  Path: ${result.installPath}\n  Stars: ${skill.stars}\n  Security: ${formatSecurityBadge(skill)}\n\nAvailable on next session.` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
        }
      },
    });

    // vibeclaw_trending
    api.registerTool({
      name: "vibeclaw_trending",
      description: "Show trending skills/plugins/MCP servers from Vibe Index.",
      parameters: Type.Object({
        period: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month")])),
        type: Type.Optional(Type.Union([Type.Literal("skill"), Type.Literal("plugin"), Type.Literal("mcp"), Type.Literal("marketplace")])),
        limit: Type.Optional(Type.Number()),
      }),
      async execute(_id: string, params: { period?: string; type?: string; limit?: number }) {
        try {
          const result = await client.trending({ period: (params.period as "day"|"week"|"month") ?? "week", type: params.type, limit: params.limit ?? 5 });
          if (!result.success || result.data.length === 0) return { content: [{ type: "text" as const, text: "No trending data." }] };
          const p = params.period === "day" ? "today" : params.period === "month" ? "this month" : "this week";
          let output = `Trending on Vibe Index ${p}:\n\n`;
          result.data.forEach((r, i) => { output += formatResource(r, i + 1) + "\n"; });
          return { content: [{ type: "text" as const, text: output }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
        }
      },
    });

    // vibeclaw_manage
    api.registerTool({
      name: "vibeclaw_manage",
      description: "List or uninstall VibeClaw-installed skills.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("uninstall")]),
        skillName: Type.Optional(Type.String()),
      }),
      async execute(_id: string, params: { action: string; skillName?: string }) {
        if (params.action === "list") {
          const skills = await listInstalledSkills();
          if (skills.length === 0) return { content: [{ type: "text" as const, text: "No VibeClaw-installed skills." }] };
          return { content: [{ type: "text" as const, text: `VibeClaw skills (${skills.length}):\n${skills.map(s => `  - ${s}`).join("\n")}` }] };
        }
        if (params.action === "uninstall" && params.skillName) {
          const removed = await uninstallSkill(params.skillName);
          return { content: [{ type: "text" as const, text: removed ? `Uninstalled "${params.skillName}".` : `"${params.skillName}" not found.` }] };
        }
        return { content: [{ type: "text" as const, text: "Specify action and skillName." }] };
      },
    });

    // vibeclaw_audit
    api.registerTool({
      name: "vibeclaw_audit",
      description: "Audit VibeClaw-installed skills against latest Vibe Index security data.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const skills = await listInstalledSkills();
          if (skills.length === 0) return { content: [{ type: "text" as const, text: "No skills to audit." }] };
          const lines: string[] = [];
          for (const name of skills) {
            const res = await client.search(name, { type: "skill", limit: 1 });
            if (!res.success || res.data.length === 0) { lines.push(`${name}: not found`); continue; }
            const issue = checkSecurity(res.data[0]);
            lines.push(issue ? `${name}: FLAGGED` : `${name}: safe (${formatSecurityBadge(res.data[0])})`);
          }
          return { content: [{ type: "text" as const, text: `Audit (${skills.length} skills):\n${lines.join("\n")}` }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error: ${(err as Error).message}` }] };
        }
      },
    });

    // System prompt injection
    api.on("before_prompt_build", () => ({
      prependContext: [
        "\n## VibeClaw - Skill Discovery (Powered by Vibe Index)\n",
        "You have these VibeClaw tools: vibeclaw_search, vibeclaw_install, vibeclaw_trending, vibeclaw_manage, vibeclaw_audit.",
        "When you cannot fulfill a request, use vibeclaw_search to find a skill and vibeclaw_install to install it.",
        "When asked about trending tools, use vibeclaw_trending.\n",
      ].join("\n"),
    }));

    api.logger.info("VibeClaw plugin registered - 5 tools available (search, install, trending, manage, audit)");
  },
};

export default vibeClawPlugin;
