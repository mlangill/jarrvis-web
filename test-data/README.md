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
| `picrust2/chemerin/` | A real PICRUSt2 run from the Langille lab (chemerin knockout mice) | `ko_pred_metagenome_contrib`, `pred_metagenome_contrib` (EC) and `path_abun_contrib` contrib outputs, QIIME 2 `taxonomy.tsv` for the sequence IDs, and `metadata.tsv` (`#SampleID`, source, cage, genotype). Not downloaded by the fetch script |

`public/demo/` holds the example data the app's demo button loads: `TSD-stratified.tsv.gz` (the full TSD table above, gzipped, 2 MB) and `TSD-metadata.tsv` (a copy of the TSD metadata). The fetch script rebuilds them.

The files directly under `picrust2/` and `humann2/` are tiny synthetic tables from unit tests. They're for checking formats, not realistic sizes. `picrust2/chemerin/` is the realistic PICRUSt2 set; there's no large real HUMAnN file yet.

`mh2/` is gitignored and must not be committed: it holds a Microbiome Helper 2 stratified table from an IMR client, a random 300-KO subset of it, and placeholder metadata, for local testing only.
