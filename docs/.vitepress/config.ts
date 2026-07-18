import { defineConfig } from "vitepress";
import { readFileSync } from "node:fs";

const repository = "https://github.com/MaTriXy/Monkey.D.Loopy";
const release = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as { version: string };

export default defineConfig({
  title: "Monkey D Loopy",
  titleTemplate: ":title · Monkey D Loopy",
  description:
    "Build bounded, crash-resumable agent loops with verified termination and budget guarantees.",
  base: "/Monkey.D.Loopy/",
  lang: "en-US",
  cleanUrls: true,
  lastUpdated: true,
  sitemap: {
    hostname: "https://matrixy.github.io/Monkey.D.Loopy/",
  },
  head: [
    ["meta", { name: "theme-color", content: "#7667e8" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "Monkey D Loopy" }],
    [
      "meta",
      {
        property: "og:image",
        content:
          "https://matrixy.github.io/Monkey.D.Loopy/images/monkey-d-loopy-logo-512.png",
      },
    ],
    ["link", { rel: "icon", href: "/Monkey.D.Loopy/images/monkey-d-loopy-logo-256.png" }],
    ["link", { rel: "manifest", href: "/Monkey.D.Loopy/site.webmanifest" }],
  ],
  themeConfig: {
    logo: "/images/monkey-d-loopy-logo-256.png",
    siteTitle: "Monkey D Loopy",
    nav: [
      { text: "Guide", link: "/" },
      { text: "LoopSpec", link: "/loopspec" },
      { text: "Recipes", link: "/recipes" },
      { text: "Agent guide", link: "/agent-guide" },
      {
        text: `v${release.version}`,
        items: [
          { text: "CLI reference", link: "/cli" },
          { text: "Runtime", link: "/runtime" },
          { text: "Operator", link: "/operator" },
          { text: "Release on GitHub", link: `${repository}/releases/tag/v${release.version}` },
        ],
      },
    ],
    sidebar: [
      {
        text: "Start here",
        items: [
          { text: "Why Loopy", link: "/" },
          { text: "First loop", link: "/quickstart" },
          { text: "Using Loopy with agents", link: "/agent-guide" },
          { text: "Verified recipes", link: "/recipes" },
          { text: "CLI reference", link: "/cli" },
        ],
      },
      {
        text: "Define and prove",
        items: [
          { text: "LoopSpec reference", link: "/loopspec" },
          { text: "Runtime and guarantees", link: "/runtime" },
          { text: "MCP server", link: "/mcp" },
        ],
      },
      {
        text: "Operate",
        items: [
          { text: "Local operator", link: "/operator" },
          { text: "Artifacts and notifications", link: "/artifacts-and-notifications" },
          { text: "Guarded evolution", link: "/guarded-evolution" },
          { text: "Platform roadmap", link: "/operator-platform-roadmap" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: repository }],
    search: { provider: "local" },
    outline: { level: [2, 3], label: "On this page" },
    editLink: {
      pattern: `${repository}/edit/main/docs/:path`,
      text: "Edit this page on GitHub",
    },
    footer: {
      message: "Bounded by construction. Durable by default. MIT licensed.",
      copyright: "Monkey D Loopy",
    },
  },
});
