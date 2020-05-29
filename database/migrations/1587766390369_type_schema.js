'use strict'

/** @type {import('@adonisjs/lucid/src/Schema')} */
const Schema = use('Schema')

class TypeSchema extends Schema {
  up () {
    this.create('types', (table) => {
      table.increments()
      table.string('type', 100).notNullable().unique()
      table.string('description', 200).notNullable()
    })
  }

  down () {
    this.drop('types')
  }
}

module.exports = TypeSchema
