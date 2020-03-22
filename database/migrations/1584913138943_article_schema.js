'use strict'

/** @type {import('@adonisjs/lucid/src/Schema')} */
const Schema = use('Schema')

class ArticleSchema extends Schema {
  up () {
    this.create('articles', (table) => {
      table.increments()
      table.string('title', 255).notNullable()
      table.text('slug').notNullable().unique()
      table.text('content').nullable()
      table.boolean('published').defaultTo(false)
      table.integer('channel').unsigned().references('id').inTable('channels')
      table.integer('author').unsigned().references('id').inTable('users')
      table.timestamps()
    })
  }

  down () {
    this.drop('articles')
  }
}

module.exports = ArticleSchema
