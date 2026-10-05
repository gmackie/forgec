# Hosted transport retry

The first D1 Operations run (`60b983c8-02c9-4c4e-9644-24d91d594161`) failed with `StorageUnavailable: fetch failed`. Its failed receipt and raw report are retained beside this note. The entire profile was rerun in a fresh isolated tenant; the passing retry is selected by `certification.json`. No failed assertions were suppressed and no bridge mutation retry behavior changed. The original matrix process exited 1 because it included that failure; the subsequent aggregate validation passed all 42 cells.
