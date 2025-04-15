DROP TABLE IF EXISTS index_mime_types;
CREATE TABLE index_mime_types (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    type VARCHAR(255) NOT NULL
) ENGINE=MyISAM DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE INDEX type on index_mime_types (type);

-- Create record for blank/empty transaction
INSERT INTO index_mime_types (id,type) values (1,'');

