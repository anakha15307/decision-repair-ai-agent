import { cookies } from "next/headers";
import { getActor } from "./actors";
import { getDb } from "./db";
import { getIncident, listIncidents, type Incident } from "./incidents";
import type { Actor } from "./types";

export const ACTOR_COOKIE = "dr_actor";
export const INCIDENT_COOKIE = "dr_incident";

export async function currentActor(): Promise<Actor> {
  return getActor((await cookies()).get(ACTOR_COOKIE)?.value);
}

export async function currentIncident(): Promise<Incident | null> {
  const db = getDb();
  const id = (await cookies()).get(INCIDENT_COOKIE)?.value;
  return (id && getIncident(db, id)) || listIncidents(db)[0] || null;
}
