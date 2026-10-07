# Module: Images

Image handling is a .NET model and attachment boundary. `ImageBlobStore` owns canonical local blobs; codecs probe and normalize image bytes; `ImageTransport` defines JSON transport forms; provider helpers deduplicate and estimate image payloads.

## Units

- [Image blobs, codecs, and transport](../units/images.md)

## Cross-module contract

See [Images and attachments](../threads/images-and-attachments.md). WebUI upload routes and model serializers consume this module without becoming alternate blob authorities.
