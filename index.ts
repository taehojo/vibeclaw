/**
 * VibeClaw — Zero-Config Skill Discovery for OpenClaw
 *
 * Connects OpenClaw to the Vibe Index ecosystem (93,600+ resources).
 * When the AI agent encounters a task it can't handle, VibeClaw searches
 * the Vibe Index catalog and recommends the right skill/plugin/MCP server
 * with a ready-to-use install command.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { VibeIndexClient } from "./src/vibe-index-client.js";
import type { VibeResource } from "./src/vibe-index-client.js";
import { installSkillFromGitHub, listInstalledSkills, uninstallSkill, getInstalledSkillMeta } from "./src/skill-installer.js";

function checkSecurity(skill: VibeResource): string | null {
  if (skill.cisco_scan_result && !skill.cisco_scan_result.is_safe) {
    const sev = skill.cisco_scan_result.max_severity;
    const count = skill.cisco_scan_result.findings_count;
    return (
      `BLOCKED: "${skill.name}" failed Vibe Index security scan.\n` +
      `  Severity: ${sev}\n  Findings: ${count} issue(s)\n` +
      (skill.security_flags?.length ? `  Flags: ${skill.security_flags.join(", ")}\n` : "") +
      `See https://vibeindex.ai for details.`
    );
  }
  if (skill.security_score !== null && skill.security_score >= 25) {
    return (
      `BLOCKED: "${skill.name}" has a high security risk score (${skill.security_score}).\n` +
      (skill.security_flags?.length ? `  Flags: ${skill.security_flags.join(", ")}\n` : "") +
      `See https://vibeindex.ai for details.`
    );
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
  const typeLabel = r.resource_type.toUpperCase();
  let result = `${index}. ${r.name} (${typeLabel}) - ${stars} stars${badgeStr}\n`;
  result += `   ${desc}\n`;
  result += `   Security: ${formatSecurityBadge(r)}\n`;
  if (r.github_url) result += `   GitHub: ${r.github_url}\n`;
  return result;
}

export default definePluginEntry({
  id: "vibeclaw",
  name: "VibeClaw",
  description:
    "Zero-Config skill discovery - search, recommend, and install skills from the Vibe Index ecosystem (93,600+ resources)",

  register(api) {
    const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const apiKey = pluginConfig.apiKey as string | undefined;
    const client = new VibeIndexClient(apiKey);
    const searchOnly = (pluginConfig.searchOnly as boolean) ?? false;
    const allowedPublishers = (pluginConfig.allowedPublishers as string[]) ?? null;

    // vibeclaw_search
    api.registerTool({
      name: "vibeclaw_search",
      description:
        "Search the Vibe Index ecosystem (93,600+ resources) for skills, plugins, MCP servers, and marketplaces. " +
        "Use this when the user needs a capability you don't currently have, or when they ask about available tools. " +
        "Returns ranked results with security status. After finding a skill, use vibeclaw_install to install it.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query describing the capability needed (e.g., 'email', 'github pr', 'weather')" }),
        type: Type.Optional(Type.Union([
          Type.Literal("skill"),
          Type.Literal("plugin"),
          Type.Literal("mcp"),
          Type.Literal("marketplace"),
        ], { description: "Filter by resource type. Omit to search all types." })),
        limit: Type.Optional(Type.Number({ description: "Number of results to return (1-10, default 5)" })),
      }),
      async execute(_id, params) {
        try {
          const result = await client.search(params.query, {
            type: params.type,
            limit: params.limit ?? 5,
          });
          if (!result.success || result.data.length === 0) {
            return { content: [{ type: "text" as const, text: `No results found for "${params.query}" in the Vibe Index ecosystem.` }] };
          }
          const total = result.pagination?.total ?? result.data.length;
          let output = `Found ${total} results for "${params.query}" in Vibe Index:\n\n`;
          output += result.data.map((r, i) => formatResource(r, i + 1)).join("\n");
          output += `\nUse vibeclaw_install to install any of these skills directly.`;
          return { content: [{ type: "text" as const, text: output }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error searching Vibe Index: ${(err as Error).message}` }] };
        }
      },
    });

    // vibeclaw_install
    api.registerTool({
      name: "vibeclaw_install",
      description:
        "Install a skill directly from GitHub into OpenClaw. Downloads the SKILL.md file and places it " +
        "in ~/.openclaw/skills/ so OpenClaw loads it automatically. Use after vibeclaw_search finds a skill.",
      parameters: Type.Object({
        query: Type.String({ description: "Skill name or search query to find and install" }),
        force: Type.Optional(Type.Boolean({ description: "Reinstall even if already installed (default: false)" })),
      }),
      async execute(_id, params) {
        if (searchOnly) {
          return { content: [{ type: "text" as const, text: "Installation is disabled. This VibeClaw instance is in search-only mode." }] };
        }
        try {
          const searchResult = await client.search(params.query, { type: "skill", limit: 1 });
          if (!searchResult.success || searchResult.data.length === 0) {
            return { content: [{ type: "text" as const, text: `Could not find skill "${params.query}" in Vibe Index.` }] };
          }
          const skill = searchResult.data[0];
          if (!skill.github_owner || !skill.github_repo) {
            return { content: [{ type: "text" as const, text: `Found "${skill.name}" but it has no GitHub repository.` }] };
          }
          if (allowedPublishers && allowedPublishers.length > 0) {
            const allowed = allowedPublishers.map(p => p.toLowerCase());
            if (!allowed.includes((skill.github_owner || "").toLowerCase())) {
              return { content: [{ type: "text" as const, text: `BLOCKED: "${skill.name}" publisher "${skill.github_owner}" is not in your allowlist.` }] };
            }
          }
          const securityBlock = checkSecurity(skill);
          if (securityBlock) {
            return { content: [{ type: "text" as const, text: securityBlock }] };
          }
          const result = await installSkillFromGitHub(skill.github_owner, skill.github_repo, skill.slug || skill.name, { force: params.force });
          if (!result.success) {
            return { content: [{ type: "text" as const, text: `Failed to install "${skill.name}": ${result.error}` }] };
          }
          if (result.alreadyInstalled) {
            return { content: [{ type: "text" as const, text: `"${skill.name}" is already installed at ${result.installPath}. Use force: true to reinstall.` }] };
          }
          let output = `Installed "${result.skillName}" successfully!\n\n`;
          output += `  Location: ${result.installPath}\n`;
          output += `  Source: ${result.sourceUrl}\n`;
          output += `  Publisher: ${skill.github_owner}\n`;
          output += `  Stars: ${skill.stars}\n`;
          output += `  Security: ${formatSecurityBadge(skill)}\n`;
          output += `\nThe skill will be available in your next agent session.`;
          return { content: [{ type: "text" as const, text: output }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error installing skill: ${(err as Error).message}` }] };
        }
      },
    });

    // vibeclaw_trending
    api.registerTool({
      name: "vibeclaw_trending",
      description:
        "Get trending skills, plugins, and MCP servers from the Vibe Index ecosystem. " +
        "Shows what's gaining the most stars recently.",
      parameters: Type.Object({
        period: Type.Optional(Type.Union([
          Type.Literal("day"),
          Type.Literal("week"),
          Type.Literal("month"),
        ], { description: "Time period (default: week)" })),
        type: Type.Optional(Type.Union([
          Type.Literal("skill"),
          Type.Literal("plugin"),
          Type.Literal("mcp"),
          Type.Literal("marketplace"),
        ], { description: "Filter by resource type" })),
        limit: Type.Optional(Type.Number({ description: "Number of results (1-10, default 5)" })),
      }),
      async execute(_id, params) {
        try {
          const result = await client.trending({
            period: (params.period as "day" | "week" | "month") ?? "week",
            type: params.type,
            limit: params.limit ?? 5,
          });
          if (!result.success || result.data.length === 0) {
            return { content: [{ type: "text" as const, text: "No trending data available right now." }] };
          }
          const periodLabel = params.period === "day" ? "today" : params.period === "month" ? "this month" : "this week";
          let output = `Trending ${params.type ?? "resources"} ${periodLabel} on Vibe Index:\n\n`;
          for (let i = 0; i < result.data.length; i++) {
            const r = result.data[i];
            const growth = r.star_growth ? ` (+${r.star_growth} stars)` : "";
            output += formatResource(r, i + 1);
            if (growth) output += `   Growth: ${growth}\n`;
            output += "\n";
          }
          output += `Use vibeclaw_install to install any of these.`;
          return { content: [{ type: "text" as const, text: output }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error fetching trending: ${(err as Error).message}` }] };
        }
      },
    });

    // vibeclaw_manage
    api.registerTool({
      name: "vibeclaw_manage",
      description:
        "List or uninstall skills that were installed via VibeClaw.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("uninstall")], { description: "Action to perform" }),
        skillName: Type.Optional(Type.String({ description: "Skill name to uninstall (required for uninstall)" })),
      }),
      async execute(_id, params) {
        if (params.action === "list") {
          const skills = await listInstalledSkills();
          if (skills.length === 0) {
            return { content: [{ type: "text" as const, text: "No skills installed via VibeClaw yet." }] };
          }
          let output = `VibeClaw-installed skills (${skills.length}):\n\n`;
          for (const name of skills) output += `  - ${name}\n`;
          return { content: [{ type: "text" as const, text: output }] };
        }
        if (params.action === "uninstall") {
          if (!params.skillName) {
            return { content: [{ type: "text" as const, text: "Please specify which skill to uninstall." }] };
          }
          const removed = await uninstallSkill(params.skillName);
          if (removed) {
            return { content: [{ type: "text" as const, text: `Uninstalled "${params.skillName}". It will be removed on next session.` }] };
          }
          return { content: [{ type: "text" as const, text: `"${params.skillName}" was not found or was not installed via VibeClaw.` }] };
        }
        return { content: [{ type: "text" as const, text: `Unknown action: ${params.action}` }] };
      },
    });

    // vibeclaw_audit
    api.registerTool({
      name: "vibeclaw_audit",
      description:
        "Audit all VibeClaw-installed skills against the latest Vibe Index security data. " +
        "Detects skills that were safe when installed but have since been flagged.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const skills = await listInstalledSkills();
          if (skills.length === 0) {
            return { content: [{ type: "text" as const, text: "No VibeClaw-installed skills to audit." }] };
          }
          const flagged: string[] = [];
          const safe: string[] = [];
          const unknown: string[] = [];
          for (const name of skills) {
            const meta = await getInstalledSkillMeta(name);
            const searchResult = await client.search(name, { type: "skill", limit: 1 });
            if (!searchResult.success || searchResult.data.length === 0) {
              unknown.push(`${name} - Not found in Vibe Index (may have been removed)`);
              continue;
            }
            const skill = searchResult.data[0];
            const issue = checkSecurity(skill);
            if (issue) {
              flagged.push(`${name} - FLAGGED: ${issue}`);
            } else {
              const badge = formatSecurityBadge(skill);
              const installedAt = meta?.installedAt ? ` (installed ${meta.installedAt.split("T")[0]})` : "";
              safe.push(`${name} - ${badge}${installedAt}`);
            }
          }
          let output = `VibeClaw Security Audit - ${skills.length} skill(s) checked\n\n`;
          if (flagged.length > 0) output += `FLAGGED (${flagged.length}):\n${flagged.map(f => `  ${f}`).join("\n")}\n\n`;
          if (safe.length > 0) output += `Safe (${safe.length}):\n${safe.map(s => `  ${s}`).join("\n")}\n\n`;
          if (unknown.length > 0) output += `Unknown (${unknown.length}):\n${unknown.map(u => `  ${u}`).join("\n")}\n\n`;
          if (flagged.length === 0) output += "All installed skills passed the security check.";
          return { content: [{ type: "text" as const, text: output }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Error running audit: ${(err as Error).message}` }] };
        }
      },
    });

    // Inject system prompt context
    api.on("before_prompt_build", () => {
      const searchOnlyNote = searchOnly ? "\nNote: This instance is in search-only mode. vibeclaw_install is disabled." : "";
      const allowlistNote = allowedPublishers
        ? `\nNote: Only skills from these publishers can be installed: ${allowedPublishers.join(", ")}`
        : "";

      return {
        prependContext: [
          "",
          "## VibeClaw - Skill Discovery (Powered by Vibe Index)",
          "",
          `You have VibeClaw tools that connect to the Vibe Index ecosystem (93,600+ skills, plugins, and MCP servers).${searchOnlyNote}${allowlistNote}`,
          "",
          "When you cannot fulfill a request because a required skill is not installed, use vibeclaw_search to find it and vibeclaw_install to install it.",
          "When the user asks about trending or popular tools, use vibeclaw_trending.",
          "",
        ].join("\n"),
      };
    });

    api.logger.info("VibeClaw plugin registered - Vibe Index ecosystem connected");
  },
});
