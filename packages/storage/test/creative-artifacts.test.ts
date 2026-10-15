import type {Pool} from 'pg';
import {PostgresCreativeArtifactStore} from '../src/creative-artifacts';

const artifact={
  id:'synthetic-artifact',ownerId:'owner_synthetic_a',sessionId:'synthetic-session',
  personId:'person_synthetic_a',personaRevision:'v1',kind:'post_draft' as const,
  origin:'generated' as const,fictional:true as const,status:'draft' as const,
  content:'[가상 포스트 초안 · AI 생성] 합성',promptRevision:'v1',provider:'fake',
  model:'synthetic-model',createdAt:'2026-10-13T00:00:00.000Z',
};

test('save selects an owned session and load filters by owner',async()=>{
  const query=jest.fn().mockResolvedValueOnce({rowCount:1,rows:[{id:artifact.id}]})
    .mockResolvedValueOnce({rowCount:1,rows:[{payload:artifact}]})
    .mockResolvedValueOnce({rowCount:0,rows:[]});
  const store=new PostgresCreativeArtifactStore({query} as unknown as Pool);
  const requestKey='draft:owner_synthetic_a:synthetic-request';
  await store.save(artifact,requestKey);
  expect(query.mock.calls[0][0]).toMatch(/INSERT INTO app\.generated_artifacts[\s\S]*FROM app\.sessions/);
  expect(query.mock.calls[0][0]).toContain('s.deleted_at IS NULL');
  expect(query.mock.calls[0][1]).toEqual([artifact.id,artifact.sessionId,artifact.ownerId,artifact,requestKey]);
  await expect(store.get(artifact.ownerId,artifact.id)).resolves.toEqual(artifact);
  await expect(store.get('owner_synthetic_other',artifact.id)).resolves.toBeNull();
  expect(query.mock.calls[1][0]).toMatch(/JOIN app\.sessions s[\s\S]*s\.deleted_at IS NULL/);
  expect(query.mock.calls.slice(1).map(([,params])=>params)).toEqual([
    [artifact.id,artifact.ownerId],[artifact.id,'owner_synthetic_other'],
  ]);
});

test('save rejects a missing or foreign session',async()=>{
  const store=new PostgresCreativeArtifactStore({query:jest.fn().mockResolvedValue({rowCount:0,rows:[]})} as unknown as Pool);
  await expect(store.save(artifact,'draft:owner_synthetic_a:synthetic-request')).rejects.toThrow();
});
