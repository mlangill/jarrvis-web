#!/usr/bin/env bash
# Downloads the public test datasets into test-data/. Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

JARRVIS=https://raw.githubusercontent.com/dhwanidesai/JarrVis/HEAD/test_data
PICRUST2=https://raw.githubusercontent.com/picrust/picrust2/HEAD/tests/test_data

fetch() { # url dest
  mkdir -p "$(dirname "$2")"
  if [ -s "$2" ]; then echo "have  $2"; return; fi
  curl -fsSL "$1" -o "$2"
  echo "got   $2"
}

# Original JarrVis example: TSD metagenomes, Kraken2 taxonomy, EC RPKM, 4-column format.
fetch "$JARRVIS/TSD-sample-metadata.txt" test-data/jarrvis/TSD-sample-metadata.txt
fetch "$JARRVIS/TSD-refseq-kraken2-EC-rpkm-stratified-noMammals-SankeyFormat.txt" \
  test-data/large/TSD-refseq-kraken2-EC-rpkm-stratified-SankeyFormat.txt

# PICRUSt2 test-suite outputs (small, synthetic).
fetch "$PICRUST2/convert_table/metagenome_contrib_test.tsv.gz" test-data/picrust2/metagenome_contrib.tsv.gz
fetch "$PICRUST2/convert_table/metagenome_contrib_legacy.tsv.gz" test-data/picrust2/metagenome_contrib_legacy.tsv.gz
fetch "$PICRUST2/metagenome_pipeline/metagenome_out/pred_metagenome_strat.tsv.gz" test-data/picrust2/pred_metagenome_strat.tsv.gz
fetch "$PICRUST2/pathway_pipeline/exp_path_abun_strat.tsv.gz" test-data/picrust2/path_abun_strat.tsv.gz
fetch "$PICRUST2/convert_table/humann2_strat_example.tsv.gz" test-data/humann2/humann2_strat_example.tsv.gz
