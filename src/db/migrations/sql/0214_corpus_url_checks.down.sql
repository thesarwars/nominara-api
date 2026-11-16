-- Rollback of 0214_corpus_url_checks. Loses only the "do not fetch again" memory: the next build fetches those URLs once more.
DROP TABLE corpus_url_checks;
