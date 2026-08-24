import { createModelRequest } from "@naqsh/schemas";
import type { ModelProvider } from "@naqsh/core";
import type { ModelRequestConfigInput } from "@naqsh/schemas";

/**
 * P22's frame-analysis feature: the desktop app's `LiveViewPanel` captures
 * ONE still frame from a real, live `getDisplayMedia()` stream (never a
 * continuous feed, never sent anywhere automatically) and asks the
 * configured model provider a question about it. This module is the ONE
 * real decision (build the `ModelRequest`, call `provider.generate()`,
 * unwrap the result) -- mirrors `chatReply.ts`'s `generateChatReply` shape
 * exactly, the same "one function IS the feature" discipline.
 *
 * Genuinely real end-to-end for the deterministic mock provider (see
 * `frameAnalysis.test.ts`, which never touches the network). Against the
 * real Gemini provider it is UNVERIFIED past the request-mapping level --
 * no `GEMINI_API_KEY` is configured in this environment (same documented
 * gap as `gemini-model-provider.ts` itself).
 */

const SYSTEM_INSTRUCTION =
  "You are Naqsh, an engineering collaborator. You have been shown ONE still frame captured " +
  "live from the user's screen (a window the user explicitly chose to share, via the desktop " +
  "app's live-view capability) -- not a live video feed, not a CAD file you can query, and not " +
  "something you have any ability to interact with or modify. Answer strictly based on what is " +
  "visible in this single frame, exactly as a human looking at this one screenshot would; never " +
  "claim to have inspected geometry, measured a dimension, or changed anything beyond what is " +
  "visible in the image itself.";

const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const DATA_URL_PATTERN = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/;

export interface ParsedImageDataUrl {
  mimeType: string;
  dataBase64: string;
}

/** Pure: a browser `<canvas>.toDataURL()` string -> the mime type/base64
 * pair `ModelAttachment` needs, or `null` for anything that isn't a
 * well-formed data: URL with an allowed image mime type. Never throws --
 * the caller decides how to report "invalid" (see `analyzeFrame` below). */
export function parseImageDataUrl(dataUrl: string): ParsedImageDataUrl | null {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) return null;
  const mimeType = match[1];
  const dataBase64 = match[2];
  if (!mimeType || !dataBase64 || !ALLOWED_MIME_TYPES.has(mimeType)) return null;
  return { mimeType, dataBase64 };
}

export type FrameAnalysisOutcome = { status: "success"; text: string } | { status: "error"; error: { kind: string; message: string } };

export interface AnalyzeFrameInput {
  imageDataUrl: string;
  question: string;
  modelConfig: ModelRequestConfigInput;
}

export async function analyzeFrame(provider: ModelProvider, input: AnalyzeFrameInput): Promise<FrameAnalysisOutcome> {
  const parsed = parseImageDataUrl(input.imageDataUrl);
  if (!parsed) {
    return {
      status: "error",
      error: {
        kind: "invalid_input",
        message: "imageDataUrl must be a data: URL with an image/png, image/jpeg, or image/webp mime type."
      }
    };
  }

  const request = createModelRequest({
    systemInstruction: SYSTEM_INSTRUCTION,
    context: {},
    instruction: input.question.trim() || "Describe what is visible in this captured frame.",
    attachments: [{ kind: "image", mimeType: parsed.mimeType, dataBase64: parsed.dataBase64 }],
    config: input.modelConfig,
    sessionId: null
  });

  const result = await provider.generate(request);
  if (result.status === "error" || !result.response) {
    return { status: "error", error: result.error ?? { kind: "malformed_response", message: "Model returned no response." } };
  }
  return { status: "success", text: result.response.text ?? "" };
}
