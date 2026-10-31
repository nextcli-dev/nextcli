import { compileMDX } from "next-mdx-remote/rsc";
import NotFoundPage from "@/app/components/NotFoundPage";
import { Metadata } from "next/types";
import remarkGfm from "remark-gfm";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";
import rehypePrismPlus from "rehype-prism-plus";
import {
  loadMdxFile,
  getHeadings,
  getAllDocTitles,
  getAllDocSlugs,
  docsNav,
} from "@/lib/docs";
import { getPageNavigation } from "@/config/docsNav";
import { mdxComponents } from "@/components/docs/mdx";
import { DocsShell } from "@/components/docs/DocsShell";
import { PageNav } from "@/components/docs/PageNav";
import { CopyPageButton } from "@/components/docs/CopyPageButton";
import "../docs.css";

interface Props {
  params: Promise<{ slug?: string[] }>;
}

export async function generateStaticParams() {
  const docSlugs = getAllDocSlugs();
  const params: { slug: string[] }[] = [];

  // Root page (index)
  params.push({ slug: [] });

  // All doc pages from navigation
  for (const slug of docSlugs) {
    params.push({ slug: slug.split("/") });
  }

  return params;
}

const DOCS_ORIGIN = "https://docs.nextcli.dev";

function descriptionFromContent(content: string): string {
  const withoutCode = content.replace(/```[\s\S]*?```/g, "\n");
  for (const para of withoutCode.split(/\n\s*\n/)) {
    const text = para
      .replace(/<[^>]+>/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^#+\s+/gm, "")
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 40) continue;
    return text.length > 160 ? `${text.slice(0, 157).trimEnd()}...` : text;
  }
  return "Documentation for NextCLI, the open-source AI coding agent.";
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const slugParts = slug && slug.length > 0 ? slug : ["index"];
  const doc = await loadMdxFile(slugParts);
  if (!doc) return {};

  const pageTitle = doc.frontmatter.title as string | undefined;
  const description =
    (doc.frontmatter.description as string | undefined)?.trim() ||
    descriptionFromContent(doc.content);
  const path = slug && slug.length > 0 ? `/${slug.join("/")}` : "";
  const url = `${DOCS_ORIGIN}${path}`;

  return {
    title: pageTitle || { absolute: "NextCLI Docs" },
    description,
    alternates: { canonical: url },
    openGraph: {
      title: pageTitle ? `${pageTitle} | NextCLI Docs` : "NextCLI Docs",
      description,
      url,
      siteName: "NextCLI Docs",
      type: "website",
      images: [
        {
          url: "https://nextcli.dev/og.png",
          width: 1200,
          height: 630,
        },
      ],
    },
  };
}

export default async function DocsPage({ params }: Props) {
  const { slug } = await params;
  const slugPath = slug ?? [];
  const doc = await loadMdxFile(slugPath.length > 0 ? slugPath : ["index"]);
  if (!doc) {
    return <NotFoundPage />;
  }

  const headings = getHeadings(doc.content);
  const titleMap = getAllDocTitles();

  const { content } = await compileMDX({
    source: doc.content,
    options: {
      mdxOptions: {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [
          rehypeSlug,
          [
            rehypeAutolinkHeadings,
            {
              behavior: "wrap",
              properties: { className: ["heading-anchor"] },
            },
          ],
          [rehypePrismPlus, { ignoreMissing: true }],
        ],
      },
    },
    components: mdxComponents,
  });

  const currentSlug = slugPath.join("/");
  const { prev, next } = getPageNavigation(docsNav, currentSlug, titleMap);

  return (
    <DocsShell
      currentSlug={currentSlug}
      headings={headings}
      titleMap={titleMap}
      docsNav={docsNav}
    >
      {doc.frontmatter.title && (
        <div className="mb-2 flex items-start justify-between gap-4">
          <h1 className="text-3xl font-light tracking-tight text-black/90 dark:text-white/90">
            {doc.frontmatter.title}
          </h1>
          <CopyPageButton slug={currentSlug} />
        </div>
      )}
      {doc.frontmatter.description && (
        <p className="mb-8 text-lg text-black/50 dark:text-white/50">
          {doc.frontmatter.description.replace(/\*\*/g, "")}
        </p>
      )}
      <div className="docs-content max-w-3xl">{content}</div>
      <div className="max-w-3xl">
        <PageNav prev={prev} next={next} />
      </div>
    </DocsShell>
  );
}
