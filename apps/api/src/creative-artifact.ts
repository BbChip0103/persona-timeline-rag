/** Backend-owned fictional output, never a licensed timeline source. */
export interface CreativeArtifact {
  id:string;ownerId:string;personId:string;personaRevision:string;sessionId:string;
  kind:'post_draft';origin:'generated';fictional:true;status:'draft';content:string;
  promptRevision:string;provider:string;model:string;createdAt:string;
}
