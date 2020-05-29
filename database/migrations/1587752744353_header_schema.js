'use strict'

/** @type {import('@adonisjs/lucid/src/Schema')} */
const Schema = use('Schema')

class HeaderSchema extends Schema {
  up () {
    this.create('headers', (table) => {
      table.increments()
      table.string('name', 200).notNullable().unique()
      table.text('description').nullable()
    })
  }

  down () {
    this.drop('headers')
  }
}

module.exports = HeaderSchema
