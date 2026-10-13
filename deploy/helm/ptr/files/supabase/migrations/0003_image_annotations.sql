BEGIN;
-- Generated descriptions are separate, unreviewed annotations, never licensed captions.
CREATE TABLE source_image_revisions (
  source_id text NOT NULL REFERENCES source_posts(id), revision text NOT NULL,
  person_id text NOT NULL, source_hash text NOT NULL, content_hash text NOT NULL,
  document jsonb NOT NULL, ordinal bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY(source_id, revision)
);
CREATE TABLE source_image_annotations (
  id text PRIMARY KEY, source_id text NOT NULL, revision text NOT NULL,
  image_position integer NOT NULL CHECK(image_position >= 0), image_hash text NOT NULL,
  annotation_hash text NOT NULL, document jsonb NOT NULL,
  UNIQUE(source_id, revision, image_position),
  FOREIGN KEY(source_id,revision) REFERENCES source_image_revisions(source_id,revision),
  CHECK(document->>'humanReviewed'='false')
);
CREATE TABLE source_image_vectors (
  source_id text NOT NULL, annotation_revision text NOT NULL, model_revision text NOT NULL,
  embedding vector(1536) NOT NULL,
  PRIMARY KEY(source_id,annotation_revision,model_revision),
  FOREIGN KEY(source_id,annotation_revision) REFERENCES source_image_revisions(source_id,revision)
);
-- Defense in depth for direct SQL; reject incorrect or unsafe parent associations.
CREATE FUNCTION ptr_check_image_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM source_posts p WHERE p.id=NEW.source_id
    AND p.person_id=NEW.person_id AND p.source_hash=NEW.source_hash AND NOT p.unsafe) THEN
    RAISE EXCEPTION 'Image annotation parent mismatch or unsafe parent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER image_revision_parent BEFORE INSERT ON source_image_revisions
  FOR EACH ROW EXECUTE FUNCTION ptr_check_image_parent();
CREATE TRIGGER image_revisions_immutable BEFORE UPDATE OR DELETE ON source_image_revisions
  FOR EACH ROW EXECUTE FUNCTION ptr_reject_source_mutation();
CREATE TRIGGER image_annotations_immutable BEFORE UPDATE OR DELETE ON source_image_annotations
  FOR EACH ROW EXECUTE FUNCTION ptr_reject_source_mutation();
CREATE TRIGGER image_vectors_immutable BEFORE UPDATE OR DELETE ON source_image_vectors
  FOR EACH ROW EXECUTE FUNCTION ptr_reject_source_mutation();
INSERT INTO ptr_schema_migrations(name) VALUES('0003_image_annotations.sql');
COMMIT;
