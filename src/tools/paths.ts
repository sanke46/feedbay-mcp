/**
 * Пути, которые выбрала модель, а не человек.
 *
 * Два инструмента принимают путь файловой системы в аргументах:
 * `design_upload_image` его ЧИТАЕТ, `responses_export` в него ПИШЕТ. В
 * MCP-клиенте аргументы сочиняет модель, а в чате на них вдобавок влияет чужой
 * текст — ответы респондентов, разобранный документ. Пока путь не ограничен,
 * оба инструмента — это «прочитай любой файл сервера» и «запиши куда угодно»,
 * доступные через подсказку в чужих данных.
 *
 * Причём чтение опаснее записи: прочитанный файл `design_upload_image`
 * загружает в медиахранилище и ставит опросу фоном, то есть выкладывает его по
 * публичной ссылке. Это готовый способ вынести секрет наружу.
 *
 * ОГРАНИЧЕНИЕ — КАТАЛОГОМ, А НЕ СПИСКОМ ЗАПРЕТОВ. Запрещать `/etc` и `.env`
 * бессмысленно: списка всего, что не следует читать, не существует.
 * Разрешённый каталог — конечен и проверяем.
 *
 * ГДЕ ИМЕННО ЗАПИРАЕМ — решает `filesystemOwner` из конфигурации, а не сам
 * инструмент. На stdio у человека на его машине диск ЕГО: «загрузи
 * ~/Downloads/logo.png» — обычный сценарий, ради которого локальный MCP и
 * существует, и запереть его в каталог значит сломать рабочее, ничего не
 * защитив (доступ к своим файлам у него и так есть). На HTTP-транспорте и во
 * встроенном ассистенте диск НАШ и общий — там запираем жёстко.
 *
 * Корень берётся из `FEEDBAY_MCP_FILE_ROOT`, а если его нет — из каталога
 * выгрузок, который и так настраивается на развёртывании.
 */

import { isAbsolute, relative, resolve, sep } from "node:path";

export class PathOutsideRootError extends Error {
  constructor(what: string, root: string) {
    super(
      `${what} is outside the directory this server may touch (${root}). ` +
        `Move the file there, or set FEEDBAY_MCP_FILE_ROOT to the directory you want to allow.`,
    );
    this.name = "PathOutsideRootError";
  }
}

/** Каталог, за пределы которого инструментам ходить нельзя. */
export function fileRoot(downloadDir: string): string {
  const configured = (process.env.FEEDBAY_MCP_FILE_ROOT ?? "").trim();
  return resolve(configured || downloadDir || process.cwd());
}

/**
 * Развернуть путь и убедиться, что он внутри корня.
 *
 * Сравниваются УЖЕ развёрнутые пути: `resolve` схлопывает `..`, поэтому
 * `downloads/../../etc/passwd` не проходит. Проверка идёт по сегментам, а не
 * по `startsWith`: строковое сравнение считает `/srv/downloads-secret`
 * находящимся внутри `/srv/downloads`.
 *
 * Симлинки этим не ловятся — ссылка внутри корня может вести наружу. Честно:
 * закрыть и это означает `realpath` на каждый вызов и отдельное решение про
 * несуществующие файлы; здесь закрыт путь, по которому ходит модель.
 */
export function insideRoot(candidate: string, root: string): boolean {
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("..");
}

export function resolveInsideRoot(candidate: string, root: string, what: string): string {
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  if (!insideRoot(candidate, root)) throw new PathOutsideRootError(what, root);
  return target;
}

/**
 * Развернуть путь с учётом того, чей это диск.
 *
 * Единственная точка, которая принимает решение, — чтобы «на stdio не
 * запираем» не расползлось по инструментам двумя разными условиями.
 */
export function resolveToolPath(
  candidate: string,
  config: { downloadDir: string; filesystemOwner: "caller" | "server" },
  what: string,
): string {
  if (config.filesystemOwner === "caller") return resolve(candidate);
  return resolveInsideRoot(candidate, fileRoot(config.downloadDir), what);
}
