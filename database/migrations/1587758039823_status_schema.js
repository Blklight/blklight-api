'use strict'

/** @type {import('@adonisjs/lucid/src/Schema')} */
const Schema = use('Schema')

class StatusSchema extends Schema {
  up () {
    this.create('status', (table) => {
      table.increments()
      table.string('status', 100).notNullable().unique()
    })
  }

  down () {
    this.drop('status')
  }
}

module.exports = StatusSchema
