import type { DesignSpecification } from "@naqsh/schemas";

/** A real, structured document built from a real `DesignSpecification` --
 * every section below reads a field that genuinely exists on the record,
 * never a placeholder. Mirrors `exportThread.ts`'s identical "build real
 * text from real state, then hand it to `downloadTextFile`" shape. */
export function buildDesignSpecificationMarkdown(spec: DesignSpecification): string {
  const lines: string[] = [
    `# ${spec.description || "Design specification"}`,
    "",
    `_Version ${spec.version} · ${spec.status} · exported ${new Date().toLocaleString()}_`,
    "",
    "## Objective",
    spec.objectiveSummary,
    ""
  ];

  if (spec.material || spec.manufacturingIntent) {
    lines.push("## Material & manufacturing");
    if (spec.material) lines.push(`- **Material:** ${spec.material}`);
    if (spec.manufacturingIntent) lines.push(`- **Manufacturing intent:** ${spec.manufacturingIntent}`);
    lines.push("");
  }

  if (spec.components.length > 0) {
    lines.push("## Components", "", "| Component | Type | Geometry intent | Dimensions |", "| --- | --- | --- | --- |");
    for (const component of spec.components) {
      const dims = Object.entries(component.dimensions)
        .map(([key, value]) => `${key}: ${value}`)
        .join(", ");
      lines.push(`| ${component.name} | ${component.type} | ${component.geometryIntent} | ${dims || "—"} |`);
    }
    lines.push("");
  }

  if (spec.relationships.length > 0) {
    const byId = new Map(spec.components.map((c) => [c.id, c.name]));
    lines.push("## Relationships");
    for (const relationship of spec.relationships) {
      const source = byId.get(relationship.sourceComponentId) ?? relationship.sourceComponentId;
      const target = byId.get(relationship.targetComponentId) ?? relationship.targetComponentId;
      lines.push(`- ${source} — *${relationship.type}* → ${target}`);
    }
    lines.push("");
  }

  if (Object.keys(spec.parameters).length > 0) {
    lines.push("## Parameters");
    for (const [key, value] of Object.entries(spec.parameters)) {
      lines.push(`- **${key}:** ${JSON.stringify(value)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
