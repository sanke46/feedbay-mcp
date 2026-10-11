/**
 * Folders: the only grouping a survey has.
 *
 * Archiving a folder archives the surveys inside it, and unarchiving restores
 * exactly those — which is why "delete" here means archive first, erase second.
 */

import { z } from "zod";
import { confirmField, jsonResult, requireConfirmation, textResult, type ToolDefinition } from "./shared.js";

export const folderTools: ToolDefinition[] = [
  {
    name: "folder_list",
    title: "List folders",
    description: "Folders with their survey and response counts. Pass archived:true for the archived ones.",
    readOnly: true,
    idempotent: true,
    inputSchema: {
      archived: z.boolean().optional().describe("List archived folders instead of active ones."),
    },
    handler: async (args, { client }) => {
      const folders = await client.listFolders(args.archived === true);
      return jsonResult(
        `${folders.length} ${args.archived ? "archived" : "active"} folders.`,
        folders.map((folder) => ({
          id: folder.id,
          name: folder.name,
          description: folder.description,
          color: folder.color,
          icon: folder.icon,
          isDefault: folder.isDefault,
          surveyCount: folder.surveyCount,
          responseCount: folder.responseCount,
          archivedAt: folder.archivedAt,
        })),
      );
    },
  },
  {
    name: "folder_create",
    title: "Create a folder",
    description: "Create a folder to group surveys in. Folders are the dashboard's only grouping.",
    // Переехало из описания дословно. Без второй фразы ассистент отчитывается
    // «разложил опросы по папкам», создав пустую папку.
    invariants: [
      "A survey belongs to at most one folder, and survey_move is what puts it there.",
      "Creating a folder does not move anything into it – say so rather than implying the surveys " +
        "are already sorted.",
    ],
    readOnly: false,
    inputSchema: {
      name: z.string().min(1).max(100).describe("Folder name."),
      description: z.string().max(500).optional().describe("What the folder is for."),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional()
        .describe("Hex colour of the folder chip, e.g. #7C3AED."),
      icon: z.string().max(50).optional().describe("Icon name shown on the folder."),
    },
    handler: async (args, { client }) => {
      const folder = await client.createFolder(args);
      return jsonResult(`Created folder "${folder.name}" (id ${folder.id}).`, folder);
    },
  },
  {
    name: "folder_update",
    title: "Update a folder",
    description: "Rename a folder or change its description, colour, icon or sort position.",
    readOnly: false,
    idempotent: true,
    inputSchema: {
      folderId: z.string().describe("Folder id."),
      name: z.string().min(1).max(100).optional().describe("New name."),
      description: z.string().max(500).optional().describe("New description."),
      color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional()
        .describe("New hex colour."),
      icon: z.string().max(50).optional().describe("New icon name."),
      sortOrder: z.number().int().optional().describe("Position in the folder list."),
    },
    handler: async (args, { client }) => {
      const { folderId, ...rest } = args;
      const payload = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
      if (Object.keys(payload).length === 0) return textResult("Nothing to change – no folder fields were provided.");
      const folder = await client.updateFolder(String(folderId), payload);
      return jsonResult(`Updated folder "${folder.name}".`, folder);
    },
  },
  {
    name: "folder_set_status",
    title: "Archive / unarchive a folder",
    description:
      "Archiving a folder also archives every active survey inside it, taking them offline. Unarchiving restores " +
      "the folder and exactly those surveys.",
    readOnly: false,
    idempotent: true,
    inputSchema: {
      folderId: z.string().describe("Folder id."),
      action: z.enum(["archive", "unarchive"]).describe("What to do."),
      confirm: confirmField.describe("Required for `archive`, which takes the folder's surveys offline."),
    },
    handler: async (args, { client }) => {
      const action = args.action as "archive" | "unarchive";
      if (action === "archive") {
        const blocked = requireConfirmation(
          args.confirm,
          "Every published survey in this folder stops collecting responses. Reversible with `unarchive`.",
        );
        if (blocked) return blocked;
      }
      const folder = await client.folderAction(String(args.folderId), action);
      return jsonResult(`Folder "${folder.name}" ${action}d.`, folder);
    },
  },
  {
    name: "folder_delete_permanent",
    title: "Delete a folder forever",
    description:
      "Physically delete an archived folder together with its surveys and all their responses. Nothing restores " +
      "this. The folder must already be archived.",
    readOnly: false,
    destructive: true,
    inputSchema: {
      folderId: z.string().describe("Archived folder id."),
      confirm: confirmField,
    },
    handler: async (args, { client }) => {
      const blocked = requireConfirmation(
        args.confirm,
        "The folder, every survey inside it and all of their collected responses are erased with no way back.",
      );
      if (blocked) return blocked;
      await client.permanentlyDeleteFolder(String(args.folderId));
      return jsonResult("Folder permanently deleted.", { folderId: args.folderId, deleted: true });
    },
  },
];
