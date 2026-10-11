/**
 * Default title and config for a freshly created question.
 *
 * Mirrors `getDefaultConfig()` / `getDefaultTitle()` from
 * frontend/src/stores/survey-editor-store.ts. Those live inside a Zustand store
 * in the Next.js app, so they cannot be imported from a server package — the
 * values are duplicated here and held in place by tests/question-defaults.test.ts,
 * which reads the store source and fails when the two drift apart.
 *
 * Keeping them identical is what makes an MCP-created question indistinguishable
 * from one added through the dashboard.
 */

import { randomInt } from "node:crypto";
import type { CanonicalQuestionType } from "./question-types.js";

/**
 * Seven base36 characters, the same shape the editor store produces with
 * `Math.random().toString(36).substring(2, 9)`.
 */
export function generateQuestionId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "";
  for (let i = 0; i < 7; i += 1) id += alphabet[randomInt(alphabet.length)];
  return id;
}

export function getDefaultConfig(type: CanonicalQuestionType): Record<string, unknown> {
  switch (type) {
    case "RATING_SCALE":
    case "CSAT":
    case "CES":
      return { scale: 5, style: "stars" };
    case "NPS":
      return { scale: 10 };
    case "SINGLE_ANSWER":
    case "DROPDOWN":
      return { options: ["Option 1", "Option 2"], allowMultiple: false };
    case "MULTIPLE_ANSWER":
      return { options: ["Option 1", "Option 2"], allowMultiple: true };
    case "TEXT_ANSWER":
      return { placeholder: "", maxLength: 5000 };
    case "CONTACT_FORM":
      return {
        fields: [
          { id: "name", type: "text", label: "Full name", placeholder: "Your name", required: true, order: 0 },
          { id: "email", type: "email", label: "Email", placeholder: "name@example.com", required: true, order: 1 },
          {
            id: "phone",
            type: "phone",
            label: "Phone (optional)",
            placeholder: "+1 555 123 4567",
            required: false,
            order: 2,
          },
        ],
        enablePhoneCountryCode: true,
      };
    case "MATRIX":
      return {
        rows: [
          { id: "r1", label: "Quality" },
          { id: "r2", label: "Speed" },
          { id: "r3", label: "Price" },
        ],
        columns: [
          { id: "c1", label: "Poor" },
          { id: "c2", label: "OK" },
          { id: "c3", label: "Good" },
          { id: "c4", label: "Excellent" },
        ],
        inputType: "radio",
      };
    case "DATE":
      return { format: "MM/DD/YYYY", placeholder: "Select date", enableCalendar: true };
    case "EMAIL":
      return { placeholder: "name@example.com" };
    default:
      return {};
  }
}

export function getDefaultTitle(type: CanonicalQuestionType): string {
  switch (type) {
    case "RATING_SCALE":
      return "How would you rate...?";
    case "NPS":
      return "How likely are you to recommend us?";
    case "CSAT":
      return "How satisfied are you?";
    case "CES":
      return "How easy was it?";
    case "SINGLE_ANSWER":
      return "Select one option";
    case "MULTIPLE_ANSWER":
      return "Select all that apply";
    case "DROPDOWN":
      return "Select from the list";
    case "TEXT_ANSWER":
      return "Share your feedback";
    case "EMAIL":
      return "What is your email?";
    case "CONTACT_FORM":
      return "Contact information";
    default:
      return "New question";
  }
}
