/** One entity the hider needs. Structural so tests skip the full wire type. */
export interface HideEntity {
  rid: number;
  name: string;
  player: boolean;
}

/**
 * Split a `--hide a,b` list. Comparison is case-insensitive. Empty tokens drop.
 *
 * @param csv - Comma-separated player names, or null.
 * @returns lowercased names.
 */
export function hideNameSet(csv: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!csv) return out;
  for (const part of csv.split(",")) {
    const name = part.trim().toLowerCase();
    if (name) out.add(name);
  }
  return out;
}

/**
 * Runtime ids that must not draw: no mesh, name tag, or shadow.
 *
 * Film hides every actor rid seen since the last keyframe (rejoins). Live
 * first-person hides only the current actor rid. `--hide` matches player
 * names and still applies when self is shown.
 *
 * @param opts.entities - Current entity list.
 * @param opts.selfRids - Actor rids observed since the last world wipe.
 * @param opts.currentActorRid - Actor rid on the latest frame.
 * @param opts.hideSelf - When false, self rids are drawn.
 * @param opts.hideAllSelfRids - Film: every stored self rid. Live: current only.
 * @param opts.names - Lowercased player names from `--hide`.
 * @returns rids to suppress.
 */
export function hiddenEntityIds(opts: {
  entities: Iterable<HideEntity>;
  selfRids: ReadonlySet<number>;
  currentActorRid: number | null;
  hideSelf: boolean;
  hideAllSelfRids: boolean;
  names: ReadonlySet<string>;
}): Set<number> {
  const rids = new Set<number>();
  if (opts.hideSelf) {
    if (opts.hideAllSelfRids) {
      for (const id of opts.selfRids) rids.add(id);
    } else if (opts.currentActorRid != null) {
      rids.add(opts.currentActorRid);
    }
  }
  if (opts.names.size > 0) {
    for (const ent of opts.entities) {
      if (!ent.player) continue;
      if (opts.names.has(ent.name.trim().toLowerCase())) rids.add(ent.rid);
    }
  }
  return rids;
}
