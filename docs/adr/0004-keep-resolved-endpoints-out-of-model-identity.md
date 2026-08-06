# Keep resolved endpoints out of model identity

A credential-resolved endpoint may change where remote compaction is sent, but it does not change the model key used for persisted native replay compatibility. Keeping request routing separate preserves a stable provider/API/model identity and Pi 0.83-compatible session details; the trade-off is that different endpoints with the same model key are assumed to accept the same compaction item.
