# Fictional post drafts and image status

The public build creates fictional text post drafts. Image generation is disabled. The draft API returns `IMAGE_GENERATION_DISABLED`; it never submits an image task or incurs image-provider charges. A future image integration requires a documented Bearer API, explicit data-transfer and cost approval, and separate submit/resume accounting.

Generated drafts are marked as AI-created fiction. They are never imported as source posts, timeline events, or evaluation gold. Source image descriptions used for retrieval are a separate, provenance-checked workflow; they do not enable image generation here.

A post draft records its persona revision, fictional brief, generation settings, and generated origin. Private draft content and run records stay outside Git. Synthetic fixtures exercise the text-draft contract.
