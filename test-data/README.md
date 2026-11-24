# Test data

Run `scripts/fetch-test-data.sh` to download everything here. Files in `large/` are gitignored.

| Path | Source | Format |
| --- | --- | --- |
| `jarrvis/TSD-sample-metadata.txt` | [JarrVis](https://github.com/dhwanidesai/JarrVis) `test_data/` | Metadata: `sample_id` plus a `type` group (A/B), 10 samples |
| `large/TSD-refseq-kraken2-EC-rpkm-stratified-SankeyFormat.txt` | JarrVis `test_data/` (renamed from `...-noMammals-SankeyFormat.txt`) | 4-column `Sample, Genus, Gene, Contribution`: Kraken2 taxonomy (`p__…;s__…`), EC numbers, RPKM. 229k rows, 29 MB |
| `jarrvis/TSD-EC-stratified-subset.tsv` | The first 5 ECs of the file above, every row for those ECs | Same 4-column format, small enough to commit |
| `picrust2/metagenome_contrib.tsv.gz` | [PICRUSt2](https://github.com/picrust/picrust2) test suite (GPL-3.0) | PICRUSt2 ≥2.1 `--stratified` contrib output (long) |
| `picrust2/metagenome_contrib_legacy.tsv.gz` | PICRUSt2 test suite | Legacy PICRUSt1-style contrib output |
| `picrust2/pred_metagenome_strat.tsv.gz` | PICRUSt2 test suite | Wide stratified output (function, sequence, one column per sample) |
| `picrust2/path_abun_strat.tsv.gz` | PICRUSt2 test suite | Wide stratified pathway abundance |
| `humann2/humann2_strat_example.tsv.gz` | PICRUSt2 test suite | HUMAnN2 stratified gene families (`function\|taxon` rows) |

`public/demo/` holds the example data the app's demo button loads: `TSD-stratified.tsv.gz` (the full TSD table above, gzipped, 2 MB) and `TSD-metadata.tsv` (a copy of the TSD metadata). The fetch script rebuilds them.

The PICRUSt2 and HUMAnN2 files are tiny synthetic tables from unit tests. They're for checking formats, not realistic sizes. The Bedford Basin and IBD datasets named in `PLAN.md` aren't public here yet.
