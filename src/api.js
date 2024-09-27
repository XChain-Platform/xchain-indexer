/* XChain Indexer API */

const dotenv        = require('dotenv');
const express       = require('express');
const bodyParser    = require('body-parser');
const helmet        = require('helmet');
const cors          = require('cors');
const XChainIndexer = require('./XChainIndexer');
const jsonRouter    = require('express-json-rpc-router');

// Parse in .env config data
dotenv.config();

// Parse in the environmental variables
const INDEXER_API_PORT = process.env.INDEXER_API_PORT;
const INDEXER_NETWORK  = process.env.INDEXER_NETWORK;

// Decoder database config
const DECODER_DB_HOST  = process.env.DECODER_DB_HOST;
const DECODER_DB_PORT  = process.env.DECODER_DB_PORT;
const DECODER_DB_NAME  = process.env.DECODER_DB_NAME;
const DECODER_DB_USER  = process.env.DECODER_DB_USER;
const DECODER_DB_PASS  = process.env.DECODER_DB_PASS;

// Indexer database config
const INDEXER_DB_HOST  = process.env.INDEXER_DB_HOST;
const INDEXER_DB_PORT  = process.env.INDEXER_DB_PORT;
const INDEXER_DB_NAME  = process.env.INDEXER_DB_NAME;
const INDEXER_DB_USER  = process.env.INDEXER_DB_USER;
const INDEXER_DB_PASS  = process.env.INDEXER_DB_PASS;

// Start up the API
async function startApi(){

	// Create the app
	const app = express();

	// Use Helmet to increase security
	app.use(helmet());

	// Allow JSON requests
	app.use(bodyParser.json());

	// Allow CORS for development
	app.use(cors());

	const jsonRpcController = {

		/*
		// Handle reparsing a given block index
		async reparse({blockIndex}) {
			
		}

		// Handle rolling back to a given block index
		async rollback({blockIndex}) {
			
		}
		*/

	};

	// Allow JSON-RPC requests
	app.use(jsonRouter({methods: jsonRpcController}));

	// Start the server
	app.listen(INDEXER_API_PORT, () => {
	  console.log('API listening on port ' + INDEXER_API_PORT);
	});

	// Start the indexer
	const indexer = new XChainIndexer(DECODER_DB_HOST, DECODER_DB_PORT, DECODER_DB_NAME, DECODER_DB_USER, DECODER_DB_PASS, INDEXER_DB_HOST, INDEXER_DB_PORT, INDEXER_DB_NAME, INDEXER_DB_USER, INDEXER_DB_PASS);
	indexer.start();

}

startApi();