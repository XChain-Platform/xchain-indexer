DROP TABLE IF EXISTS index_fiats;
CREATE TABLE index_fiats (
    id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(250) NOT NULL,
    name VARCHAR(250)
) ENGINE=InnoDB DEFAULT CHARSET=utf8 COLLATE=utf8_general_ci;

CREATE UNIQUE INDEX code on index_fiats (code);

INSERT INTO index_fiats values (1,  'USD', 'US Dollar');
INSERT INTO index_fiats values (2,  'CAD', 'Canadian Dollar');
INSERT INTO index_fiats values (3,  'AUD', 'Australian Dollar');
INSERT INTO index_fiats values (4,  'MXN', 'Mexican Peso');
INSERT INTO index_fiats values (5,  'GBP', 'Great Britain Pound');
INSERT INTO index_fiats values (6,  'JPY', 'Japanese Yen');
INSERT INTO index_fiats values (7,  'CNY', 'Chinese Yuan');
INSERT INTO index_fiats values (8,  'CHF', 'Swiss Franc');
INSERT INTO index_fiats values (9,  'BRL', 'Brazilian Real');
INSERT INTO index_fiats values (10, 'INR', 'Indian Rupee');
INSERT INTO index_fiats values (11, 'EUR', 'Euro');
INSERT INTO index_fiats values (12, 'KRW', 'South Korean Won');
