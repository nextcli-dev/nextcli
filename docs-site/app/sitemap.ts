import type { MetadataRoute } from "next";
import { docsRedirects, getAllDocSlugs } from "@/lib/docs";

export const dynamic = "force-static";

const ORIGIN = "https://docs.nextcli.dev";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date("2026-10-30");
  const pages = getAllDocSlugs().filter((slug) => !docsRedirects.has(slug));

  return [
    { url: ORIGIN, lastModified },
    ...pages.map((slug) => ({
      url: `${ORIGIN}/${slug}`,
      lastModified,
    })),
  ];
}
