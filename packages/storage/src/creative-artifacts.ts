import type {Pool} from 'pg';

type OwnedArtifact={id:string;ownerId:string;sessionId:string};

/** Generated drafts remain private app data and are never queried as source evidence. */
export class PostgresCreativeArtifactStore {
  constructor(private readonly pool:Pick<Pool,'query'>) {}

  async save<T extends OwnedArtifact>(artifact:T,requestKey:string):Promise<void> {
    if(!requestKey.startsWith(`draft:${artifact.ownerId}:`)||requestKey.length>512)throw new Error('ARTIFACT_REQUEST_KEY_INVALID');
    const result=await this.pool.query(
      `INSERT INTO app.generated_artifacts(id,session_id,owner_id,payload,created_at,request_key)
       SELECT $1,$2,$3,$4::jsonb,($4::jsonb->>'createdAt')::timestamptz,$5
       FROM app.sessions s WHERE s.id=$2 AND s.owner_id=$3 AND s.deleted_at IS NULL
       AND s.person_id=($4::jsonb->>'personId')
       AND s.persona_revision=($4::jsonb->>'personaRevision')
       RETURNING id`,
      [artifact.id,artifact.sessionId,artifact.ownerId,artifact,requestKey],
    );
    if(result.rowCount!==1)throw new Error('ARTIFACT_SESSION_NOT_FOUND');
  }

  async get<T extends OwnedArtifact>(ownerId:string,id:string):Promise<T|null> {
    const result=await this.pool.query<{payload:T}>(
      `SELECT a.payload FROM app.generated_artifacts a
       JOIN app.sessions s ON s.id=a.session_id
       WHERE a.id=$1 AND a.owner_id=$2 AND s.owner_id=$2 AND s.deleted_at IS NULL`,
      [id,ownerId],
    );
    return result.rows[0]?.payload??null;
  }
}
