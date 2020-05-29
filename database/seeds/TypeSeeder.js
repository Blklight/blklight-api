"use strict";

/*
|--------------------------------------------------------------------------
| TypeSeeder
|--------------------------------------------------------------------------
|
| Make use of the Factory instance to seed database with dummy data or
| make use of Lucid models directly.
|
*/

/** @type {import('@adonisjs/lucid/src/Factory')} */
const Factory = use("Factory");
const TypeModel = use("App/Models/Type");

class TypeSeeder {
  async run() {
    await TypeModel.create({
      type: "Artigo",
      description: "Artigo simples",
    });

    await TypeModel.create({
      type: "Stories",
      description: "Publicação de duração mensal",
    });
  }
}

module.exports = TypeSeeder;
