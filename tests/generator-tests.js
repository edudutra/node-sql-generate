var should = require('should'),
	async = require('async'),
	fs = require('fs'),
	path = require('path'),
	util = require('util'),
	generate = require('../'),
	cfg = {
		mysql: {
			dev: 'mysql://root@127.0.0.1:33061/',
			travis: 'mysql://root@127.0.0.1/'
		},
		pg: {
			dev: 'postgres://sqlgenerate:password@127.0.0.1:54320/postgres',
			travis: 'postgres://postgres@127.0.0.1/postgres'
		},
		mssql: {
			dev: 'mssql://server=127.0.0.1;port=11433;user=sa;password=#SAPassword!;'
		}
	};

describe('generator', function() {
	describe('argument validation', function() {
		it('should explode if dsn is missing', function(done) {
			generate({}, function(err) {
				err.should.be.instanceOf(Error);
				err.should.have.property('message', 'options.dsn is required');
				done();
			});
		});

		it('should explode if dialect is missing', function(done) {
			generate({ dsn: 'foo!' }, function(err) {
				err.should.be.instanceOf(Error);
				err.should.have.property('message', 'options.dialect is required');
				done();
			});
		});

		it('should explode if dialect is unsupported', function(done) {
			generate({ dsn: 'foo!', dialect: 'bar' }, function(err) {
				err.should.be.instanceOf(Error);
				err.should.have.property('message', 'options.dialect must be either "mysql", "pg" or "mssql"');
				done();
			});
		});

		it('should explode if database is missing and not part of the DSN', function(done) {
			generate({ dsn: 'mysql://foo:bar@localhost/' }, function(err) {
				err.should.be.instanceOf(Error);
				err.should.have.property('message', 'options.database is required if it is not part of the DSN');
				done();
			});
		});
	});

	var database = 'node_sql_generate',
		isTravis = !!process.env.TRAVIS,
		dialects = {
			mysql: isTravis ? cfg.mysql.travis : cfg.mysql.dev,
			pg: isTravis ? cfg.pg.travis : cfg.pg.dev,
			mssql: isTravis ? null : cfg.mssql.dev
		},
		getExpected = function(name) {
			return fs.readFileSync(path.join(__dirname, 'expected', name + '.js'), 'utf8');
		},
		removeAutogeneratedComment = function(string) {
			return string.replace(/\/\/ autogenerated.+?(\r\n|\n)/, '');
		},
		options = function(options, defaults) {
			return util._extend(util._extend({}, defaults), options);
		};

	if ('mssql' in dialects) {
		//can't run mssql tests on travis
		if (isTravis) {
			delete dialects.mssql;
		}
	}

	for (var dialect in dialects) {
		var dsn = dialects[dialect],
			db = require(dialect),
			client;

		(function(dsn, db, dialect) {
			var defaults = {
				dsn: dsn,
				dialect: dialect
			};
			describe('for ' + dialect, function() {
				var realDatabase;
				switch (dialect) {
					case 'mysql':
						defaults.database = realDatabase = database;
						break;
					case 'pg':
						defaults.database = realDatabase = 'postgres';
						defaults.schema = database;
						break;
					case 'mssql':
						defaults.database = realDatabase = database;
						break;
				}

				before(function(done) {
					function runScripts(err) {
						should.not.exist(err);
						if (dialect !== 'mssql') {
							var sql = fs.readFileSync(path.join(__dirname, 'scripts', dialect + '-before.sql'), 'utf8');
							client.query(sql, done);
						}
						else {
						    var req = client.request();
							function createDatabase(next) {
								req.batch('create database node_sql_generate;', next);
							}

							function createTableFoo(next) {
								var query = 'create table node_sql_generate..foo (\n' +
									'id int not null,\n' +
									'field_1 varchar(30),\n' +
									'foo_bar_baz char(255)\n' +
								')';

								req.batch(query, next);
							}

							function createTableBar(next) {
								var query = 'create table node_sql_generate..bar (id int not null, foo_id int not null)';
								req.batch(query, next);
							}

							async.series([ createDatabase, createTableFoo, createTableBar ], done);
						}
					}

					switch (dialect) {
						case 'mysql':
							client = db.createConnection(dsn + '?multipleStatements=true');
							client.connect(runScripts);
							break;
						case 'pg':
							client = new db.Client(dsn);
							client.connect(runScripts);
							break;
						case 'mssql':
							var conn = dsn;
							if (conn.slice(-1) === ';') {
								conn = conn.substring(0, conn.length - 1);
							}

							conn = JSON.parse(
								"{\"" + conn.replace('mssql://', '')
									.replace(/=/g, '\":\"')
									.replace(/;/g, '\",\"') + "\"}"
							);

							client = new db.Connection(conn);
							client.connect(runScripts);
							break;
					}
				});

				after(function(done) {
					function runScripts(callback) {
						var sql;
						if (dialect === 'mssql') {
							client.request().batch('drop database node_sql_generate', callback);
							return;
						}

						if (dialect === 'mysql') {
							sql = fs.readFileSync(path.join(__dirname, 'scripts', dialect + '-after.sql'), 'utf8');
						} else if (dialect === 'pg') {
							sql = 'drop table node_sql_generate.foo;';
							sql += ' drop table node_sql_generate.bar;';
							sql += ' drop schema node_sql_generate;';
						} 

						client.query(sql, callback);
					}

					switch (dialect) {
						case 'mysql':
							runScripts(function(scriptErr) {
								client.end(function(err) {
									done(scriptErr || err);
								});
							});
							break;
						case 'pg':
							runScripts(function(scriptErr) {
								client.end();
								done(scriptErr);
							});
							break;
						case 'mssql':
							runScripts(function(scriptErr) {
								client.close();
								done(scriptErr);
							});
							break;
					}
				});

				it('should set tables property on stats', function(done) {
					var options = {
						dsn: dsn
					};
					switch (dialect) {
						case 'pg':
							options.schema = database;
							break;
						case 'mysql':
						case 'mssql':
							options.database = database;
							break;
					}
					generate(options, function(err, stats) {
						should.not.exist(err);
						stats.should.have.property('tables');
						stats.tables.should.have.property('foo');
						stats.tables.foo.should.have.property('columns');
						stats.tables.foo.columns.should.eql([
							{ name: 'id', property: 'id', type: 'int', charLength: null, nullable: false },
							{ name: 'field_1', property: 'field1', type: 'varchar', charLength: 30, nullable: true },
							{ name: 'foo_bar_baz', property: 'fooBarBaz', type: 'char', charLength: 255, nullable: true }
						]);
						stats.tables.should.have.property('bar');
						stats.tables.bar.should.have.property('columns');
						stats.tables.bar.columns.should.eql([
							{ name: 'id', property: 'id', type: 'int', charLength: null, nullable: false },
							{ name: 'foo_id', property: 'fooId', type: 'int', charLength: null, nullable: false }
						]);
						done();
					});
				});

				it('with dialect embedded in dsn', function(done) {
					var options = {
						dsn: dsn
					};
					switch(dialect) {
						case 'pg':
							options.schema = database;
							break;
						case 'mysql':
						case 'mssql':
							options.database = database;
							break;
					}
					generate(options, function(err, stats) {
						should.not.exist(err);
						var expected = getExpected('defaults');
						removeAutogeneratedComment(stats.buffer).should.equal(expected);
						done();
					});
				});

				it('with defaults', function(done) {
					generate(defaults, function(err, stats) {
						should.not.exist(err);
						var expected = getExpected('defaults');
						removeAutogeneratedComment(stats.buffer).should.equal(expected);
						done();
					});
				});

				it('with custom indentation character', function(done) {
					generate(options({ indent: '  ' }, defaults), function(err, stats) {
						should.not.exist(err);
						var expected = getExpected('indent');
						removeAutogeneratedComment(stats.buffer).should.equal(expected);
						done();
					});
				});

				it('with camel cased name', function(done) {
					generate(options({ camelize: true }, defaults), function(err, stats) {
						should.not.exist(err);
						var expected = getExpected('camelize');
						removeAutogeneratedComment(stats.buffer).should.equal(expected);
						done();
					});
				});

				it('with custom EOL character', function(done) {
					generate(options({ eol: '\r\n' }, defaults), function(err, stats) {
						should.not.exist(err);
						var expected = getExpected('eol');
						removeAutogeneratedComment(stats.buffer).should.equal(expected);
						done();
					});
				});

				it('with prepended text', function(done) {
					generate(options({ prepend: '//hello world' }, defaults), function(err, stats) {
						should.not.exist(err);
						var expected = getExpected('prepend');
						removeAutogeneratedComment(stats.buffer).should.equal(expected);
						done();
					});
				});

				it('with appended text', function(done) {
					generate(options({ append: '//hello world' }, defaults), function(err, stats) {
						should.not.exist(err);
						var expected = getExpected('append');
						removeAutogeneratedComment(stats.buffer).should.equal(expected);
						done();
					});
				});

				it('with omitted comments', function(done) {
					generate(options({ omitComments: true }, defaults), function(err, stats) {
						should.not.exist(err);
						var expected = getExpected('omit-comments');
						stats.buffer.should.equal(expected);
						done();
					});
				});

				it('with schema included', function(done) {
					generate(options({ includeSchema: true }, defaults), function(err, stats) {
						should.not.exist(err);
						var expected = getExpected('include-schema');
						removeAutogeneratedComment(stats.buffer).should.equal(expected);
						done();
					});
				});

				it('with modularization', function(done) {
					generate(options({ modularize: true }, defaults), function(err, stats) {
						should.not.exist(err);
						var expected = getExpected('modularize');
						removeAutogeneratedComment(stats.buffer).should.equal(expected);
						done();
					});
				});

				it('with metadata', function(done) {
					generate(options({ includeMeta: true }, defaults), function(err, stats) {
						should.not.exist(err);
						var expected = getExpected('include-meta');
						removeAutogeneratedComment(stats.buffer).should.equal(expected);
						done();
					});
				});

				it('with regular expression', function(done) {
					generate(options({ excludeRegex: [ /foo/ ] }, defaults), function(err, stats) {
						should.not.exist(err);
						var expected = getExpected('regular-expression');
						removeAutogeneratedComment(stats.buffer).should.equal(expected);
						done();
					});
				});
			});
		}(dsn, db, dialect));
	}
});
