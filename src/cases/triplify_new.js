const fs = require('fs');
const path = require('path');
const stream = require('stream');
const csv_parse = require('csv-parse');
const util = require('util');
const ttl_write = require('@graphy/content.ttl.write');
const once = require('events').once;
const pipeline = util.promisify(stream.pipeline);

const geocoder = require('../common/geocoder.js');
const sparql = require('../common/sparql.js');
const utils = require('./utils.js');

const H_PREFIXES = require('../common/prefixes.js');


// maps iso3166_alpha2_country codes to names
const H_CODES_TO_NAMES_COUNTRIES = require('../common/countries_codes-to-names.json');

const PDR_DATA = require('../common/paths.js').data;
const P_FIPS_PLACES = path.join(PDR_DATA, 'wikidata/wikidata_fips.json');

// load cache
let h_fips_places = require(P_FIPS_PLACES);

// inverse mapping
const H_NAMES_TO_CODES_COUNTRIES = Object.entries(H_CODES_TO_NAMES_COUNTRIES)
	.reduce((h_out, [si_key, s_value]) => ({
		...h_out,
		[s_value]: si_key,
	}), {});

// add name for China
Object.assign(H_NAMES_TO_CODES_COUNTRIES, {
	China: 'CN',
	'North Macedonia': 'MK',
	'North Ireland': 'GB-NIR',
	'Northern Ireland': 'GB-NIR',
	Palestine: 'PS',
	'Vatican City': 'VA',
	'Republic of Ireland': 'IE',
	'Viet Nam': 'VN',
	'Hong Kong SAR': 'HK',
	'Republic of Korea': 'KR',
	'The Bahamas': 'BS',
	'The Gambia': 'GM',
	Eswatini: 'SZ',
	Czechia: 'CZ',
	Burma: 'MM',
});

const H_MANNUAL_COUNTRY_MATCH = {
	Czechia: 'Czech Republic',
	Burma: 'Myanmar',
};





// CLI inputs
let a_inputs = process.argv.slice(2);

// convert directories into files
// Given a list of directories, extract the CSV file paths from each of them as a list
{
	// each input path
	for(let pr_input of a_inputs) {
		// stat file
		let d_stat = fs.statSync(pr_input);

		// directory
		if(d_stat.isDirectory()) {
			// remove path
			a_inputs.splice(a_inputs.indexOf(pr_input), 1);

			// push csv fiels
			a_inputs.push(
				...fs.readdirSync(pr_input)
					.filter(s => s.endsWith('.csv'))
					.filter(s => (new Date(s.replace(/\.csv$/, ''))).getTime() >= new Date('03-22-2020').getTime())
					.map(s => path.join(pr_input, s)));
		}
	}
}

// create turtle writer
let ds_writer = ttl_write({
	prefixes: H_PREFIXES,
});

// pipe writer to stdout
ds_writer.pipe(process.stdout);

// flush object for consolidating places
let hc3_flush = {};

// set of affected locations
let as_affected = new Set();

// normalize suffix string
const suffix = s => s.trim().replace(/\s+/g, '_');

// normalize place suffix string
const place = s => suffix(s.replace(/^([^,]+),\s*(.+)$/, (s_, s_1, s_2) => (s_2? s_2+'.': '')+s_1));

// inject hash based on test
const inject = (w_test, hc3_inject) => w_test? hc3_inject: {};

// const zeroPad = (num, places) => String(num).padStart(places, '0');

// main
(async() => {
	for(let pr_input of a_inputs) {
		// make writable stream for converting flat files to triples
		let ds_triplify = new stream.Writable({
			// objects on writable side
			objectMode: true,

			// writable callback
			async write(g_row, s_encoding, fk_write) {
				// normalize keys and vlaues
				for(let [s_key, s_value] of Object.entries(g_row)) {
					g_row[s_key.trim()] = 'string' === typeof s_value? s_value.trim(): null;
				}

				// destructure row
				let {
					FIPS: s_fips,
					Admin2: s_admin2,
					Province_State: s_state,
					// 'Province/State': s_state,
					Country_Region: s_country,
					// 'Country/Region': s_country,
					Last_Update: s_last_update,
					// 'Last Update': s_last_update,
					Lat: s_lat,
					Long_: s_long,
					Confirmed: s_confirmed,
					Deaths: s_deaths,
					Recovered: s_recovered,
					Active: s_active,
					Suspected: s_suspected,
					Combined_Key: s_combined_key,
				} = g_row;

				// skip new structure for now.... >_>
				if(!s_country) return fk_write();

				s_country = s_country.replace(/\*/g, '');

				if(H_MANNUAL_COUNTRY_MATCH[s_country.trim()]){
					s_country = H_MANNUAL_COUNTRY_MATCH[s_country.trim()];
				}

				let hc2_record = {};

				let si_iso3166_alpha2_country = H_NAMES_TO_CODES_COUNTRIES[s_country];
				if(!si_iso3166_alpha2_country && s_country in H_CODES_TO_NAMES_COUNTRIES) {
					si_iso3166_alpha2_country = s_country;
					s_country = H_CODES_TO_NAMES_COUNTRIES[s_country];
				}

				let sc1p_country = si_iso3166_alpha2_country || suffix(s_country);

				let sc1_place = null;
				let sc1_country = null;
				let g_place = null;
				let g_place_fips = null;

				let sc1p_place_short;

				s_combined_key = `${s_admin2 ? s_admin2+", " : ""}${s_state ? s_state+", " : ""}${s_country}`;


				// remove diamond princess qualifier
				// s_state = s_state.trim()
				// 	.replace(/(Unassigned?)/i, '').trim()
				// 	.replace(/\(?From Diamond Princess\)?/i, '').trim()
				// 	.replace(/\s{2,}/, ' ');

				s_admin2 = s_admin2.trim()
					.replace(/(Unassigned(,\s*)?)/i, '').trim();

				s_combined_key = s_combined_key.trim()
					.replace(/(Unassigned(,\s*)?)/i, '').trim();




				// cruise ships
				if(/\b(cruise|ship|princess)\b/i.test(s_combined_key) || /MS Zaandam\b/i.test(s_combined_key)) {
					// diamond princess
					if(/diamond\s+princess/i.test(s_combined_key)) {
						s_state = 'Diamond Princess Cruise Ship';
					}
					// grand princess
					else if(/grand\s+princess/i.test(s_combined_key)) {
						s_state = 'Grand Princess Cruise Ship';
					}
					else if(/MS Zaandam\b/i.test(s_combined_key)) {
						s_state = 'MS Zaandam Cruise Ship';
					}
					// unspecified
					else if('Cruise Ship' === s_country) {
						s_state = 'Unspecified Cruise Ship';
					}

					// other
					else {
						console.warn(`Unhandled cruise ship: '${s_combined_key}'`);
						// debugger;
					}

					if(si_iso3166_alpha2_country){

						g_place = await geocoder.place(s_country);

						if(!g_place) {
							// debugger;
							console.warn(`No wikidata COUNTRY for "${s_place}"`);

							return fk_write();
						}

						sc1_country = 'wd:'+g_place.place_wikidata;

						sc1p_place_short = `${si_iso3166_alpha2_country}.${suffix(s_state)}`;

						sc1_place = `covid19-place:${sc1p_place_short}`;

						// make sure country and region exist
						// hc3_flush = utils.add_country_triples(hc3_flush, sc1_country, country_name = s_country);
						// hc3_flush = utils.add_place_triples(hc3_flush, sc1_place, sc1_country, place_name = `${s_state}, ${s_country}`, sc1p_place_type = 'Place');
						Object.assign(hc3_flush, {
							[sc1_country]: {
								a: 'covid19:Country',
								'rdfs:label': `@en"${s_country}`,
							},

							[sc1_place]: {
								a: 'covid19:Place',
								'rdfs:label': `@en"${s_state}, ${s_country}`,
								'covid19:country': sc1_country,
							},
						});

						Object.assign(hc2_record, {
							'covid19:location': sc1_place,
							// 'covid19:country': sc1_place,
						});

						

						as_affected.add(sc1_country);

					}else{

						sc1p_place_short = `${suffix(s_state)}`;

						sc1_place = `covid19-place:${sc1p_place_short}`;

						// make sure place exists
						hc3_flush[sc1_place] = {
							a: 'covid19:Place',
							'rdfs:label': '@en"'+s_state,
						};

						// relate record to place
						Object.assign(hc2_record, {
							'covid19:location': sc1_place,
							// 'covid19:country': sc1_place,
						});

						// add to affeced
						if(sc1_place) as_affected.add(sc1_place);
					}

					
				}
				// geocode
				else {
					
					let s_fips_code  = null;
					let a_wikidata_place = null;



					if(s_fips){

					
						// let n_fips = parseInt(s_fips);
						// let s_fips_code = zeroPad(n_fips, 5);
						s_fips_code = s_fips.padStart(5, '0');

						if(/^000/i.test(s_fips_code)){
							s_fips_code = s_fips_code.replace(/^000/i, "");
						}



						if(h_fips_places[s_fips_code]){
							a_wikidata_place = h_fips_places[s_fips_code];
						}else{
							let a_wikidata_res;
							

							a_wikidata_res = await sparql.wikidata(/* syntax: sparql */ `
								select ?place ?fips{
									?place ${s_fips_code.length === 2 ? "wdt:P5087" : "wdt:P882"} "${s_fips_code}" .
								}
							`);
							

							if(a_wikidata_res){
								if(a_wikidata_res.length > 0){
									a_wikidata_place = a_wikidata_res[0].place.value;
									h_fips_places[s_fips_code] = a_wikidata_place;
								}
							}						
						}

						if(a_wikidata_place){
							let s_superdivision = `${s_state ? s_state+", " : ""}${s_country}`;


							let g_state = await geocoder.place(s_superdivision);

							if(!g_state){
								// debugger;
								console.warn(`No wikidata STATE for "${g_state}"`);

								g_place = {
									type: 'county',
									place_wikidata: a_wikidata_place.replace("http://www.wikidata.org/entity/", ""),
									place_name: s_combined_key,
									country_wikidata: 'Q30',
									country_name: "United States of America",
									context: null,
								};

							}else{
								let a_contexts = [
									{
										"id": g_state.type,
										"wikidata": g_state.place_wikidata,
										"text": g_state.place_name
									},
									{
										"id": "country.19352517729256050",
										"short_code": "us",
										"wikidata": "Q30",
										"text": "United States"
									}
								]

								g_place = {
									type: 'county',
									place_wikidata: a_wikidata_place.replace("http://www.wikidata.org/entity/", ""),
									place_name: s_combined_key,
									country_wikidata: 'Q30',
									country_name: "United States of America",
									context: a_contexts,
								};
							}

							

							
						}

						
					}

					if(!g_place){
						// geocode place
						let s_place = s_combined_key;

						// if(/\bUS\b$/i.test(s_place)){
						// 	s_place = s_place.replace(/\bUS\b$/i, "United States");
						// }


						g_place = await geocoder.place(s_place);

						


						if(!g_place) {
							// debugger;
							console.warn(`No wikidata place for "${s_place}"`);

							return fk_write();
						}

						// if(g_place_fips){
						// 	if(g_place_fips.place_wikidata !== g_place.place_wikidata){
						// 		g_place = g_place_fips;
						// 	}
						// }

					}

					


					// county
					if(/\bCounty\b/i.test(s_admin2)) {
						g_place.type = 'county';
					}

					// // coerce
					// if('locality' === g_place.type) {
					// }

					sc1p_place_short = `${sc1p_country}${s_state? '.'+suffix(s_state): ''}${s_admin2? '.'+suffix(s_admin2): ''}`;

					let place_name = g_place.place_name ? g_place.place_name : s_combined_key;
					let country_name = g_place.country_name ? g_place.country_name : s_country;

					// depending on place type
					switch(g_place.type) {
						// country
						case 'country': {
							// if(si_iso3166_alpha2_country) {
								if(s_state || s_admin2)
								{
									sc1_place = 'wd:'+g_place.place_wikidata;

									if(g_place.country_wikidata){
										sc1_country = 'wd:'+g_place.country_wikidata;
									}else{
										sc1_country = null;
									}
									let sc1p_place_type = 'Region';
									hc3_flush = utils.add_context_place_hierachy_triples(hc3_flush, g_place.context, sc1_place, place_name, sc1_country, country_name,  sc1p_place_type);

									
									
									
								}else{
									// mint place iri
									// sc1_country = sc1_place = `covid19-country:${si_iso3166_alpha2_country}`;
									sc1_country = sc1_place = 'wd:'+g_place.place_wikidata;

									// make sure country exists
									// hc3_flush[sc1_place] = {
									// 	a: 'covid19:Country',
									// 	'rdfs:label': `@en"${g_place.place_name ? g_place.place_name : s_country}`,
									// 	// 'owl:sameAs': 'wd:'+g_place.place_wikidata,
									// };
									hc3_flush = utils.add_country_triples(hc3_flush, sc1_country, g_place.place_name ? g_place.place_name : s_country);
								}
								

								
							// }
							

							break;
						}

						// region
						case 'region': {
							let sc1p_place_type = 'Region';

							// mint place iri
							// sc1_place = `covid19-region:${sc1p_place_short}`;
							sc1_place = 'wd:'+g_place.place_wikidata;

							// mint country iri
							// sc1_country = `covid19-country:${sc1p_country}`;
							sc1_country = 'wd:'+g_place.country_wikidata;



							// make sure country and region exist

							hc3_flush = utils.add_context_place_hierachy_triples(hc3_flush, g_place.context, sc1_place, place_name, sc1_country, country_name,  sc1p_place_type);

							
							// Object.assign(hc3_flush, {
							// 	[sc1_country]: {
							// 		a: 'covid19:Country',
							// 		'rdfs:label': `@en"${s_country}`,
							// 		// ...inject(g_place.country_wikidata, {
							// 		// 	'owl:sameAs': 'wd:'+g_place.country_wikidata,
							// 		// }),
							// 	},

							// 	[sc1_place]: {
							// 		a: 'covid19:Region',
							// 		'rdfs:label': `@en"${s_combined_key}`,
							// 		// 'owl:sameAs': 'wd:'+g_place.place_wikidata,
							// 		...inject(si_iso3166_alpha2_country, {
							// 			'covid19:country': sc1_country,
							// 		}),
							// 	},
							// });

							break;
						}

						// place
						case 'airforce base':
						case 'locality':
						case 'district':
						case 'county':
						case 'place': {
							let sc1p_place_type = 'Place';

							sc1_place = 'wd:'+g_place.place_wikidata;

							// us county
							if('county' === g_place.type || ('place' === g_place.type && 'US' === sc1p_country)) {
								// mint place iri
								// sc1_place = `covid19-county:${sc1p_place_short}`;

								sc1p_place_type = 'County';
							}
							// airforce base
							else if('airforce base' === g_place.type) {
								// mint place iri
								// sc1_place = `covid19-place:${sc1p_place_short}`;

								sc1p_place_type = 'Airforce_Base';
							}
							// locality
							else if('locality' === g_place.type || 'district' === g_place.type) {
								// mint place iri
								// sc1_place = `covid19-place:${sc1p_place_short}`;

								sc1p_place_type = g_place.type[0].toUpperCase()+g_place.type.substr(1);
							}
							// city
							// else {
							// 	// mint place iri
							// 	// sc1_place = `covid19-city:${sc1p_place_short}`;
							// 	sc1_place = 'wd:'+g_place.place_wikidata;
							// }

							// mint country iri
							// sc1_country = `covid19-country:${sc1p_country}`;
							sc1_country = 'wd:'+g_place.country_wikidata;

							// make sure country and place exist

							hc3_flush = utils.add_context_place_hierachy_triples(hc3_flush, g_place.context, sc1_place, place_name, sc1_country, country_name,  sc1p_place_type);
							

							// Object.assign(hc3_flush, {
							// 	[sc1_country]: {
							// 		a: 'covid19:Country',
							// 		'rdfs:label': `@en"${s_country}`,
							// 		// ...inject(g_place.country_wikidata, {
							// 		// 	'owl:sameAs': 'wd:'+g_place.country_wikidata,
							// 		// }),
							// 	},

							// 	[sc1_place]: {
							// 		a: 'covid19:'+sc1p_place_type,
							// 		'rdfs:label': `@en"${s_combined_key}`,
							// 		// 'owl:sameAs': 'wd:'+g_place.place_wikidata,

							// 		// only emit triples for region --> country
							// 		...inject(sc1_country, {
							// 			'covid19:country': sc1_country,
							// 		}),
							// 	},
							// });

							break;
						}

						default: {
							// debugger;
							console.warn(`place type not handled: "${g_place.type}"`);
						}
					}

					// add fips code
					if(s_fips_code){
						if(hc3_flush[sc1_place]){
							if(s_fips_code.length === 2){
								Object.assign(hc3_flush[sc1_place], {
									'covid19:areaFIPS': `"${s_fips_code}`,
								});
							}else{
								Object.assign(hc3_flush[sc1_place], {
									'covid19:countyFIPS': `"${s_fips_code}`,
								});
							}
							
						}
						// else{
						// 	hc3_flush[sc1_place] = {
						// 		'covid19:fips': `"${s_fips_code}`,
						// 	};
						// }
						
					}
					

					let s_geo = null;

					
					if(s_lat && s_long){
						let lat = parseFloat(s_lat);
						let long = parseFloat(s_long);
						if(lat !== 0 || long !== 0){

							s_geo = `^geosparql:wktLiteral"<http://www.opengis.net/def/crs/EPSG/0/4326>POINT(${long} ${lat})`;
						}
					}

					if(s_geo){
						let sc1_geometry = `covid19-geometry:${sc1p_place_short}.Geometry`;
						if(hc3_flush[sc1_place]){
							Object.assign(hc3_flush[sc1_place], {
								'geosparql:hasGeometry': sc1_geometry,
							});
						}
						// else{
						// 	debugger
						// 	hc3_flush[sc1_place] = {
						// 		'geosparql:hasGeometry': sc1_geometry,
						// 	};
						// }
						

						hc3_flush[sc1_geometry] = {
							a: 'sf:Point',
							'geosparql:asWKT': s_geo,
						}

					}

					

					// relate record to place
					Object.assign(hc2_record, {
						'covid19:location': sc1_place,
						// 'covid19:country': sc1_country,
					});

					// // add to affeced places
					// as_affected.add(sc1_place);

					// add to affeced places
					if(sc1_country) as_affected.add(sc1_country);

					geocoder.save();
				}

				

				// fix stupid timestamp string
				s_last_update = s_last_update.replace(/(\d+)(?::\d+)?\s*([ap]m)/i, (s_ignore, s_hour, s_meridian) => ((+s_hour) + ('pm' === s_meridian.toLowerCase()? 12: 0))+':00');

				// date string
				let dt_updated = new Date(s_last_update+'Z');

				// format date string for record IRI
				let s_date_formatted = dt_updated.toISOString();

				let s_time_instant = `covid19-instant:${s_date_formatted}`;
				hc3_flush[s_time_instant] = {
					a: 'time:Instant',
					'time:inXSDDateTime': dt_updated,
				};

				// create record IRI
				// let sc1_record = `covid19-record:${sc1p_country}${s_state? '.'+place(s_state):''}.${suffix(s_date_formatted)}`;
				let sc1_record = `covid19-record:${sc1p_place_short}.${suffix(s_date_formatted)}`;

				if(!hc2_record['covid19:location']) {
					// debugger;
					console.warn(`Failed to geocode "${s_state}, ${s_country}" possibly due to a missing country name in mappings`);
					return fk_write();
				}

				for(let sc1_key in hc2_record) {
					if(!hc2_record[sc1_key]) {
						// debugger;
						console.warn(`Missing record property '${sc1_key}' for ${sc1_record}`);
						return fk_write();
					}
				}

				if(!sc1_record) {
					console.warn(`Invalid record '${sc1_record}'`);
					return fk_write();
				}

				// push triples
				ds_writer.write({
					type: 'c3',
					value: {
						[sc1_record]: {
							a: 'covid19:Record',
							'rdfs:label': `@en"${dt_updated.toISOString()} cases in ${s_combined_key}`,
							'dct:description': `@en"The COVID-19 cases record for ${s_combined_key}, on ${dt_updated.toGMTString()}`,
							'covid19:lastUpdate': s_time_instant,

							...hc2_record,

							...inject(s_confirmed, {
								'covid19:confirmed': +s_confirmed,
							}),

							...inject(s_deaths, {
								'covid19:deaths': +s_deaths,
							}),

							...inject(s_recovered, {
								'covid19:recovered': +s_recovered,
							}),

							...inject(s_active, {
								'covid19:active': +s_active,
							}),

							...inject(s_suspected, {
								'covid19:suspected': +s_suspected,
							}),
						},
					},
				});

				// done with row
				fk_write();
			},
		});


		// pipeline
		try {
			await pipeline(...[
				// read from file
				fs.createReadStream(pr_input),

				// parse csv
				csv_parse({
					columns: true,
				}),

				// pipe thru transform
				ds_triplify,
			]);
		}
		catch(e_pipeline) {
			// debugger;
			throw e_pipeline;
		}
	}


	for(let sc1_key in hc3_flush) {
		if(!hc3_flush[sc1_key]) {
			console.warn(`Missing flush property '${sc1_key}'`);
			delete hc3_flush[sc1_key];
		}
	}


	
	let s_dump = JSON.stringify(h_fips_places, null, '\t');
	fs.writeFileSync(P_FIPS_PLACES, s_dump);

	

	// flush all pending triples
	ds_writer.write({
		type: 'c3',
		value: {
			// about locations
			...hc3_flush,

			// disease outbreak node
			[`covid19-disease:COVID-19_DiseaseOutbreak`]: {
				'covid19:countryAffected': [...as_affected],
			},
		},
	});

	// end writer
	ds_writer.end();
})();

