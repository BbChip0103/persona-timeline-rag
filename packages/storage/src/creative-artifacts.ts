import type {Pool} from 'pg';

type OwnedArtifact={id:string;ownerId:string;sessionId:string};

/** Generated drafts remain private app data and are never queried as source evidence. */
export class PostgresCreativeArtifactStore {
  constructor(private readonly pool:Pick<Pool,'query'>) {}

  async save<T extends OwnedArtifact>(artifact:T):Promise<void> {
    const result=await this.pool.query(
      `INSERT INTO app.generated_artifacts(id,session_id,owner_id,payload,created_at)
       SELECT $1,$2,$3,$4::jsonb,($4::jsonb->>'createdAt')::timestamptz
       FROM app.sessions s WHERE s.id=$2 AND s.owner_id=$3
       AND s.person_id=($4::jsonb->>'personId')
       AND s.persona_revision=($4::jsonb->>'personaRevision')
       RETURNING id`,
      [artifact.id,artifact.sessionId,artifact.ownerId,artifact],
    );
    if(result.rowCount!==1)throw new Error('ARTIFACT_SESSION_NOT_FOUND');
  }

  async get<T extends OwnedArtifact>(ownerId:string,id:string):Promise<T|null> {
    const result=await this.pool.query<{payload:T}>(
      'SELECT payload FROM app.generated_artifacts WHERE id=$1 AND owner_id=$2',
      [id,ownerId],
    );
    return result.rows[0]?.payload??null;
  }
}
